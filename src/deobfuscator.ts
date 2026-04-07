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
        if (
          decl.init &&
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

  // Core matcher used for both FunctionDeclaration and var/arrow wrappers
  private static isWrapperCallTo(
    funcNode:
      | t.FunctionDeclaration
      | t.FunctionExpression
      | t.ArrowFunctionExpression,
    baseName: string
  ): boolean {
    // params: exactly 2 identifiers
    if (funcNode.params.length !== 2) return false;
    const [p0, p1] = funcNode.params;
    if (!t.isIdentifier(p0) || !t.isIdentifier(p1)) return false;

    // Extract the "return ..." expression or concise arrow body
    let retExpr: t.Expression | null = null;

    if (t.isArrowFunctionExpression(funcNode)) {
      if (t.isBlockStatement(funcNode.body)) {
        const body = funcNode.body.body;
        if (body.length !== 1 || !t.isReturnStatement(body[0])) return false;
        if (!body[0].argument) return false;
        retExpr = body[0].argument as t.Expression;
      } else {
        retExpr = funcNode.body as t.Expression;
      }
    } else {
      const body = funcNode.body.body;
      if (body.length !== 1 || !t.isReturnStatement(body[0])) return false;
      if (!body[0].argument) return false;
      retExpr = body[0].argument as t.Expression;
    }

    if (!retExpr || !t.isCallExpression(retExpr)) return false;
    if (!t.isIdentifier(retExpr.callee, { name: baseName })) return false;
    if (retExpr.arguments.length !== 2) return false;
    const [a0, a1] = retExpr.arguments;

    const isPlusMinus = (op: any) => op === "-" || op === "+";
    const isParam = (x: t.Node, id: t.Identifier) =>
      t.isIdentifier(x, { name: id.name });

    const matchArg = (expr: t.Node): boolean => {
      if (t.isIdentifier(expr) && (isParam(expr, p0) || isParam(expr, p1))) {
        return true;
      }
      if (
        t.isBinaryExpression(expr) &&
        isPlusMinus(expr.operator) &&
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

    return matchArg(a0 as t.Node) && matchArg(a1 as t.Node);
  }

  static findDecryptFunctionFromFuncDecl(
    path: NodePath<t.FunctionDeclaration>,
    vmContext: vm.Context,
    baseDecryptFunc: string
  ): { name: string; binding?: Binding } | undefined {
    const node = path.node;
    if (!node.id) return;
    if (!this.isWrapperCallTo(node, baseDecryptFunc)) return;

    vm.runInContext(generate(node).code, vmContext);
    path.scope.crawl();
    const binding =
      path.scope.getBinding(node.id.name) ||
      path.parentPath.scope.getBinding(node.id.name) ||
      undefined;

    path.remove();
    return { name: node.id.name, binding };
  }

  static findDecryptFunctionFromVarDecl(
    path: NodePath<t.VariableDeclarator>,
    vmContext: vm.Context,
    baseDecryptFunc: string
  ): { name: string; binding?: Binding } | undefined {
    const node = path.node;
    if (!t.isIdentifier(node.id)) return;
    const name = node.id.name;
    const init = node.init;
    if (!init) return;

    let funcNode:
      | t.FunctionExpression
      | t.ArrowFunctionExpression
      | null = null;

    if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
      funcNode = init;
    }
    if (!funcNode) return;

    if (!this.isWrapperCallTo(funcNode, baseDecryptFunc)) return;

    // Generate and eval its parent VariableDeclaration so the const/let binding exists in VM
    const parentDecl = path.parentPath.node;
    let code: string;
    if (t.isVariableDeclaration(parentDecl)) {
      code = generate(parentDecl).code;
    } else {
      // fallback: just define const name = <fn>;
      code = `const ${name} = ${generate(funcNode).code};`;
    }
    vm.runInContext(code, vmContext);

    // Ensure bindings are updated
    path.scope.crawl();
    const binding =
      path.scope.getBinding(name) ||
      path.parentPath.scope.getBinding(name) ||
      undefined;

    // Remove this declarator; if parent decl has no more, prune it
    const varDeclPath = path.parentPath as NodePath<t.VariableDeclaration>;
    if (varDeclPath.node.declarations.length === 1) {
      varDeclPath.remove();
    } else {
      path.remove();
    }

    return { name, binding };
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
  static decryptMapKeysByBinding(
    decyptFuncBinding: Binding,
    vmContext: vm.Context
  ) {
    const references = decyptFuncBinding.referencePaths;
    for (const reference of references) {
      const refParentPath = reference.parentPath;
      if (!refParentPath) continue;
      if (t.isReturnStatement(refParentPath.parent)) continue;

      try {
        const code = generate(refParentPath.node).code;
        const value = vm.runInContext(code, vmContext);
        refParentPath.replaceWith(t.valueToNode(value));
      } catch {
        // ignore bad evals
      }
    }
  }

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

  // 1) Find strings-array function
  traverse(ast, {
    FunctionDeclaration(path) {
      const name = ObfuscatedStrings.findStringsArray(path, decryptCtx);
      if (name) {
        funcObfStrings = name;
        path.stop();
      }
    },
  });
  if (!funcObfStrings) {
    console.error("Strings function was not found");
    return;
  }

  // 2) Find base decrypt
  traverse(ast, {
    FunctionDeclaration(path) {
      if (!baseDecryptFunc) {
        const name = ObfuscatedStrings.findBaseDecryptFunction(
          path,
          decryptCtx,
          funcObfStrings!
        );
        if (name) {
          baseDecryptFunc = name;
        }
      }
    },
  });
  if (!baseDecryptFunc) {
    console.error("Base decrypt function was not found");
    return;
  }

  // 3) Execute shuffler IIFE
  traverse(ast, {
    CallExpression(path) {
      if (foundShuffle) return;
      const ok = ObfuscatedStrings.shuffleObfuscatedStrings(
        path,
        decryptCtx,
        funcObfStrings!
      );
      if (ok) foundShuffle = true;
    },
  });

  // 4) Collect wrappers: function declarations
  traverse(ast, {
    FunctionDeclaration(path) {
      const r = ObfuscatedStrings.findDecryptFunctionFromFuncDecl(
        path,
        decryptCtx,
        baseDecryptFunc!
      );
      if (r) {
        decryptFuncNames.add(r.name);
        if (r.binding) wrapperBindings.push(r.binding);
      }
    },
  });

  // 5) Collect wrappers: variable declarators (function expr or arrow)
  traverse(ast, {
    VariableDeclarator(path) {
      const r = ObfuscatedStrings.findDecryptFunctionFromVarDecl(
        path,
        decryptCtx,
        baseDecryptFunc!
      );
      if (r) {
        decryptFuncNames.add(r.name);
        if (r.binding) wrapperBindings.push(r.binding);
      }
    },
  });

  // 6) Replace via bindings
  for (const b of wrapperBindings) {
    DecryptStrings.decryptMapKeysByBinding(b, decryptCtx);
  }

  // 7) Fallback: evaluate calls by name (wrappers and base)
  const namesForEval = new Set<string>(decryptFuncNames);
  namesForEval.add(baseDecryptFunc!);
  DecryptStrings.decryptCallsByName(ast, namesForEval, decryptCtx);

  // 8) Replace maps
  const mapReplacer = new MapReplacer();
  traverse(ast, {
    VariableDeclarator(path) {
      const ok = mapReplacer.parseMap(path);
      if (!ok) return;

      mapReplacer.replaceBinaryOpCalls();
      mapReplacer.replaceMapIndexing();

      path.stop();
      path.remove();
    },
  });

  // 9) Simplify unwrapOrElse-like
  traverse(ast, {
    CallExpression(path) {
      SimplifyIndexing.simplifyUnwrapOrElse(path);
    },
  });

  // 10) Bracket -> dot
  const validIdentifierRegex =
    /^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[$A-Z\_a-z]*$/;

  traverse(ast, {
    MemberExpression(path) {
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