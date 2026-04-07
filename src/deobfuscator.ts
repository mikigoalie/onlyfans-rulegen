import * as parser from "@babel/parser";
import traverse, { Binding, NodePath, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import beautify from "js-beautify";
import { readFileSync, writeFile } from "fs";
import vm from "vm";

const binop = [
  "+",
  "-",
  "/",
  "%",
  "*",
  "**",
  "&",
  "|",
  ">>",
  ">>>",
  "<<",
  "^",
  "==",
  "===",
  "!=",
  "!==",
  "in",
  "instanceof",
  ">",
  "<",
  ">=",
  "<=",
  "|>",
] as const;
type BinaryOperator = (typeof binop)[number];
const isBinaryOperator = (x: any): x is BinaryOperator => binop.includes(x);

class ObfuscatedStrings {
  static findStringsArray(
    path: NodePath<t.FunctionDeclaration>,
    vmContext: vm.Context
  ): string | undefined {
    const node = path.node;
    const funcExpr = node.body.body;
    if (node.params.length !== 0) return;
    if (funcExpr.length !== 2 || !t.isVariableDeclaration(funcExpr[0])) return;

    const declarations = (funcExpr[0] as t.VariableDeclaration).declarations;
    if (declarations.length !== 1) return;

    const obfStrings = declarations[0];
    if (!t.isArrayExpression(obfStrings.init)) return;

    for (const elemNode of obfStrings.init.elements) {
      if (!t.isStringLiteral(elemNode)) return;
    }
    if (!node.id) return;

    vm.runInContext(generate(node).code, vmContext);
    path.remove();
    return node.id.name;
  }

  static findBaseDecryptFunction(
    path: NodePath<t.FunctionDeclaration>,
    vmContext: vm.Context,
    obfStringsFunc: string
  ): string | undefined {
    const node = path.node;
    if (node.params.length !== 2) return;

    const hasStringsInit = node.body.body.some((stmt) => {
      if (!t.isVariableDeclaration(stmt)) return false;
      for (const decl of stmt.declarations) {
        if (!decl.init) continue;
        if (
          t.isCallExpression(decl.init) &&
          t.isIdentifier(decl.init.callee, { name: obfStringsFunc })
        ) {
          return true;
        }
      }
      return false;
    });
    if (!hasStringsInit) return;

    if (!node.id) return;

    vm.runInContext(generate(node).code, vmContext);
    path.remove();
    return node.id.name;
  }

  static findDecryptFunction(
    path: NodePath<t.FunctionDeclaration>,
    vmContext: vm.Context,
    baseDecryptFunc: string
  ): { name: string; binding?: Binding } | undefined {
    const node = path.node;
    const funcExpr = node.body.body;
    if (node.params.length !== 2 || funcExpr.length !== 1) return;
    if (!t.isReturnStatement(funcExpr[0]) || !funcExpr[0].argument) return;

    const ret = funcExpr[0].argument;
    if (!t.isCallExpression(ret)) return;
    if (!t.isIdentifier(ret.callee, { name: baseDecryptFunc })) return;

    const args = ret.arguments;
    if (args.length !== 2) return;
    const [a0, a1] = args;

    const isPlusOrMinus = (
      op: any
    ): op is t.BinaryExpression["operator"] => op === "-" || op === "+";

    const isParam = (x: t.Node, id: t.Identifier) =>
      t.isIdentifier(x, { name: id.name });

    const matchArg = (expr: t.Node, p0: t.Identifier, p1: t.Identifier) => {
      if (t.isIdentifier(expr)) {
        return isParam(expr, p0) || isParam(expr, p1);
      }
      if (
        t.isBinaryExpression(expr) &&
        isPlusOrMinus(expr.operator) &&
        ((t.isIdentifier(expr.left) &&
          (isParam(expr.left, p0) || isParam(expr.left, p1)) &&
          t.isNumericLiteral(expr.right)) ||
          (t.isIdentifier(expr.right) &&
            (isParam(expr.right, p0) || isParam(expr.right, p1)) &&
            t.isNumericLiteral(expr.left)))
      ) {
        return true;
      }
      return false;
    };

    if (!t.isIdentifier(node.params[0]) || !t.isIdentifier(node.params[1]))
      return;
    const p0 = node.params[0] as t.Identifier;
    const p1 = node.params[1] as t.Identifier;

    if (!matchArg(a0 as t.Node, p0, p1)) return;
    if (!matchArg(a1 as t.Node, p0, p1)) return;

    if (!node.id) return;

    // Register in VM
    vm.runInContext(generate(node).code, vmContext);

    // Ensure bindings are up-to-date
    path.scope.crawl();

    // Try to fetch binding; may be undefined in some nested scopes
    const binding =
      path.scope.getBinding(node.id.name) ||
      path.parentPath.scope.getBinding(node.id.name) ||
      undefined;

    // Remove wrapper function from code
    path.remove();

    return { name: node.id.name, binding };
  }

  static shuffleObfuscatedStrings(
    path: NodePath<t.CallExpression>,
    vmContext: vm.Context,
    funcObfStrings: string
  ): boolean | undefined {
    const node = path.node;

    if (node.arguments.length !== 2) return;
    if (!t.isIdentifier(node.arguments[0], { name: funcObfStrings })) return;
    if (!t.isNumericLiteral(node.arguments[1])) return;

    const code = generate(t.expressionStatement(node)).code;
    vm.runInContext(code, vmContext);

    if (t.isUnaryExpression(path.parentPath.node)) {
      path.parentPath.remove();
    } else {
      path.remove();
    }
    return true;
  }
}

class DecryptStrings {
  // Original binding-based replacement (kept; works when binding exists)
  static decryptMapKeysByBinding(
    decyptFuncBinding: Binding,
    vmContext: vm.Context
  ) {
    const references = decyptFuncBinding.referencePaths;
    for (const reference of references) {
      const refParentPath = reference.parentPath;
      if (!refParentPath) continue;
      if (t.isReturnStatement(refParentPath.parent)) continue;

      const code = generate(refParentPath.node).code;
      const value = vm.runInContext(code, vmContext);
      refParentPath.replaceWith(t.valueToNode(value));
    }
  }

  // Fallback: directly evaluate call expressions by function name
  static decryptCallsByName(
    ast: t.File | t.Program,
    funcNames: Set<string>,
    vmContext: vm.Context
  ) {
    traverse(ast, {
      CallExpression(path) {
        const node = path.node;
        if (!t.isIdentifier(node.callee)) return;
        if (!funcNames.has(node.callee.name)) return;

        // Only attempt when arguments are safe (mostly literals/binary ops)
        // We still eval the generated code; if it throws, skip gracefully.
        try {
          const code = generate(node).code;
          const value = vm.runInContext(code, vmContext);
          path.replaceWith(t.valueToNode(value));
        } catch {
          // ignore and continue
        }
      },
    });
  }
}

enum MapFuncType {
  CallOneArg,
  CallThreeArg,
}

class MapReplacer {
  decryptionMap: {
    [key: string]: BinaryOperator | MapFuncType | string;
  };
  mapName: string | undefined;
  scope: Scope | undefined;

  constructor() {
    this.decryptionMap = {};
  }

  public parseMap(path: NodePath<t.VariableDeclarator>): boolean | undefined {
    let node = path.node;
    if (!t.isObjectExpression(node.init)) return;
    if (!t.isIdentifier(node.id)) return;

    let flag = false;
    node.init.properties = node.init.properties.filter((elemNode) => {
      if (!t.isObjectProperty(elemNode)) return true;
      if (!t.isIdentifier(elemNode.key)) return true;
      const key = elemNode.key.name;

      if (t.isFunctionExpression(elemNode.value)) {
        let funcBody = elemNode.value.body.body;
        if (funcBody.length !== 1) return true;
        if (!t.isReturnStatement(funcBody[0])) return true;
        const ret = funcBody[0].argument;

        if (t.isBinaryExpression(ret)) {
          this.decryptionMap[key] = ret.operator;
          flag = true;
        } else if (t.isCallExpression(ret)) {
          if (ret.arguments.length === 3) {
            this.decryptionMap[key] = MapFuncType.CallThreeArg;
          } else if (ret.arguments.length === 1) {
            this.decryptionMap[key] = MapFuncType.CallOneArg;
          }
        }
      } else if (t.isStringLiteral(elemNode.value)) {
        this.decryptionMap[key] = elemNode.value.value;
      } else {
        return true;
      }
      return false;
    });

    if (flag) {
      this.mapName = node.id.name;
      this.scope = path.scope;
      return flag;
    }
  }

  public replaceBinaryOpCalls() {
    this.scope?.traverse(
      this.scope.path.node,
      {
        CallExpression(path: NodePath<t.CallExpression>) {
          const node = path.node;
          if (!t.isMemberExpression(node.callee)) return;

          const { object, property } = node.callee;
          if (!t.isIdentifier(object, { name: this.mapName })) return;
          if (!t.isStringLiteral(property)) return;

          if (path.node.arguments.length !== 2) return;
          const op = this.decryptionMap[property.value];
          if (!isBinaryOperator(op)) return;
          let unObfNode = t.binaryExpression(
            op,
            node.arguments[0] as t.Expression,
            node.arguments[1] as t.Expression
          );
          path.replaceWith(unObfNode);
        },
      },
      this
    );
  }

  public replaceMapIndexing() {
    if (!this.mapName) return;
    this.scope?.crawl();
    const references = this.scope?.getBinding(this.mapName)?.referencePaths;
    if (!references) return;

    for (const reference of references) {
      const mapIndex = reference.parentPath;
      const mapIndexParent = mapIndex?.parentPath;
      if (!mapIndex || !t.isMemberExpression(mapIndex.node)) continue;
      if (!mapIndexParent) continue;
      const mapIndexParentNode = mapIndexParent.node;

      const { object, computed, property } = mapIndex.node;

      if (
        object !== reference.node ||
        !computed ||
        !t.isStringLiteral(property)
      ) {
        continue;
      }

      const mapVal = this.decryptionMap[property.value];

      if (typeof mapVal === "string" && !isBinaryOperator(mapVal)) {
        mapIndex.replaceWith(t.valueToNode(mapVal));
      } else if (
        typeof mapVal !== "string" &&
        t.isCallExpression(mapIndexParentNode)
      ) {
        if (mapIndexParentNode.arguments.length !== 0) {
          const func = mapIndexParentNode.arguments[0] as t.Expression;
          const args = mapIndexParentNode.arguments.slice(1);

          mapIndexParentNode.callee = func;
          mapIndexParentNode.arguments = args;
        }
      }
    }
  }
}

class SimplifyIndexing {
  static simplifyUnwrapOrElse(path: NodePath<t.CallExpression>) {
    const node = path.node;
    if (!t.isCallExpression(path.node.callee)) return;
    if (node.arguments.length !== 3) return;

    const args = node.arguments as t.Expression[];
    const object = args[0];
    const property = args[1];
    const elseExpr = args[2];

    const resultObj = this.simplifyMultiPropery(object, property);
    if (!resultObj) return;

    const op = t.logicalExpression("||", resultObj, elseExpr);
    path.replaceWith(op);
    path.skip();
  }

  private static simplifyMultiPropery(
    object: t.Expression,
    property: t.Expression
  ): t.Expression | undefined {
    if (
      !t.isStringLiteral(property) ||
      (t.isStringLiteral(property) && !property.value.includes("."))
    ) {
      return t.memberExpression(object, property, true);
    } else {
      const properties = property.value.split(".");
      let resultObj: t.Expression | undefined;
      for (const prop of properties) {
        const propLit = t.stringLiteral(prop);
        if (!resultObj) {
          resultObj = t.memberExpression(object, propLit, true);
        } else {
          resultObj = t.memberExpression(resultObj, propLit, true);
        }
      }
      return resultObj;
    }
  }
}

function deobfuscate(source: string) {
  const ast = parser.parse(source);

  const decryptCtx = vm.createContext();

  let funcObfStrings: string | undefined;
  let baseDecryptFunc: string | undefined;
  const wrapperBindings: Binding[] = [];
  const decryptFuncNames = new Set<string>();
  let foundShuffle = false;

  traverse(ast, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      const funcName = ObfuscatedStrings.findStringsArray(path, decryptCtx);
      if (funcName) {
        funcObfStrings = funcName;
        path.stop();
        return;
      }
    },
  });

  if (!funcObfStrings) {
    console.error("Strings function was not found");
    return;
  }

  traverse(ast, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (!baseDecryptFunc) {
        const funcName = ObfuscatedStrings.findBaseDecryptFunction(
          path,
          decryptCtx,
          funcObfStrings!
        );
        if (funcName) {
          baseDecryptFunc = funcName;
          return;
        }
      }
    },
  });

  if (!baseDecryptFunc) {
    console.error("Base decrypt function was not found");
    return;
  }

  // Execute the shuffler IIFE
  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      if (foundShuffle) return;
      const ok = ObfuscatedStrings.shuffleObfuscatedStrings(
        path,
        decryptCtx,
        funcObfStrings!
      );
      if (ok) foundShuffle = true;
    },
  });

  // Collect wrappers that call base (and chain through discovered wrappers)
  traverse(ast, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      const tryFind = (callee: string) =>
        ObfuscatedStrings.findDecryptFunction(path, decryptCtx, callee);

      // first try base
      const r0 = tryFind(baseDecryptFunc!);
      if (r0) {
        decryptFuncNames.add(r0.name);
        if (r0.binding) wrapperBindings.push(r0.binding);
        return;
      }

      // then try already found wrappers
      for (const name of decryptFuncNames) {
        const r = tryFind(name);
        if (r) {
          decryptFuncNames.add(r.name);
          if (r.binding) wrapperBindings.push(r.binding);
          return;
        }
      }
    },
  });

  // Replace via bindings where available
  for (const b of wrapperBindings) {
    DecryptStrings.decryptMapKeysByBinding(b, decryptCtx);
  }
  // Fallback: direct call-eval by function name
  if (decryptFuncNames.size > 0) {
    DecryptStrings.decryptCallsByName(ast, decryptFuncNames, decryptCtx);
  } else {
    console.error("No decrypt wrappers were found! Falling back to base only.");
    // Also include base function name to catch direct base calls, if any
    if (baseDecryptFunc) {
      DecryptStrings.decryptCallsByName(ast, new Set([baseDecryptFunc]), decryptCtx);
    }
  }

  const mapReplacer = new MapReplacer();
  traverse(ast, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      const ok = mapReplacer.parseMap(path);
      if (!ok) return;

      mapReplacer.replaceBinaryOpCalls();
      mapReplacer.replaceMapIndexing();

      path.stop();
      path.remove();
    },
  });

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      SimplifyIndexing.simplifyUnwrapOrElse(path);
    },
  });

  const validIdentifierRegex =
    /^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[$A-Z\_a-z]*$/;

  traverse(ast, {
    MemberExpression(path: NodePath<t.MemberExpression>) {
      let { object, property, computed } = path.node;
      if (!computed) return;
      if (!t.isStringLiteral(property)) return;
      if (!validIdentifierRegex.test(property.value)) return;
      path.replaceWith(
        t.memberExpression(object, t.identifier(property.value), false)
      );
    },
  });

  let deobfCode = generate(ast, { comments: false }).code;
  deobfCode = beautify(deobfCode, {
    indent_size: 2,
    space_in_empty_paren: true,
  });

  writeCodeToFile(deobfCode);
}

function writeCodeToFile(code: string) {
  let outputPath = process.argv[3];
  writeFile(outputPath, code, (err) => {
    if (err) {
      console.error("Error writing file", err);
      return;
    }
    console.log(`Wrote file to ${outputPath}`);
  });
}

deobfuscate(readFileSync(process.argv[2], "utf8"));