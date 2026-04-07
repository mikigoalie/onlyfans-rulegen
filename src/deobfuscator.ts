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

function isStringsArrayFuncLike(
  fn: t.FunctionExpression | t.FunctionDeclaration
): boolean {
  if (fn.params.length !== 0) return false;
  const body = fn.body.body;
  if (body.length !== 2) return false;
  if (!t.isVariableDeclaration(body[0])) return false;
  const decls = body[0].declarations;
  if (decls.length !== 1) return false;
  const arrInit = decls[0].init;
  if (!t.isArrayExpression(arrInit)) return false;
  for (const el of arrInit.elements) {
    if (!t.isStringLiteral(el)) return false;
  }
  return true;
}

class ObfuscatedStrings {
  static findStringsArray(
    path: NodePath<t.FunctionDeclaration>,
    vmContext: vm.Context
  ): string | undefined {
    const node = path.node;
    if (!isStringsArrayFuncLike(node)) return;
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
        const init = decl.init;
        if (
          init &&
          t.isCallExpression(init) &&
          t.isIdentifier(init.callee, { name: obfStringsFunc })
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

  private static isWrapperCallTo(
    funcNode:
      | t.FunctionDeclaration
      | t.FunctionExpression
      | t.ArrowFunctionExpression,
    baseName: string
  ): boolean {
    if (funcNode.params.length !== 2) return false;
    const [p0, p1] = funcNode.params;
    if (!t.isIdentifier(p0) || !t.isIdentifier(p1)) return false;

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

    let fnNode:
      | t.FunctionExpression
      | t.ArrowFunctionExpression
      | null = null;

    if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
      fnNode = init;
    }
    if (!fnNode) return;

    if (!this.isWrapperCallTo(fnNode, baseDecryptFunc)) return;

    const parentDecl = path.parentPath.node;
    let code: string;
    if (t.isVariableDeclaration(parentDecl)) {
      code = generate(parentDecl).code;
    } else {
      code = `const ${name} = ${generate(fnNode).code};`;
    }
    vm.runInContext(code, vmContext);

    path.scope.crawl();
    const binding =
      path.scope.getBinding(name) ||
      path.parentPath.scope.getBinding(name) ||
      undefined;

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
        // ignore
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
          // ignore
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
    const node = path.node;
    if (!t.isObjectExpression(node.init)) return;
    if (!t.isIdentifier(node.id)) return;

    let flag = false;
    node.init.properties = node.init.properties.filter((elemNode) => {
      if (!t.isObjectProperty(elemNode)) return true;
      if (!t.isIdentifier(elemNode.key)) return true;
      const key = elemNode.key.name;

      if (t.isFunctionExpression(elemNode.value)) {
        const funcBody = elemNode.value.body.body;
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

          if (node.arguments.length !== 2) return;
          const op = this.decryptionMap[property.value];
          if (!isBinaryOperator(op)) return;
          const unObfNode = t.binaryExpression(
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
        t.isCallExpression(mapIndexParent.node)
      ) {
        if (mapIndexParent.node.arguments.length !== 0) {
          const func = mapIndexParent.node.arguments[0] as t.Expression;
          const args = mapIndexParent.node.arguments.slice(1);
          mapIndexParent.node.callee = func;
          mapIndexParent.node.arguments = args;
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
    FunctionDeclaration(path) {
      const name = ObfuscatedStrings.findStringsArray(path, decryptCtx);
      if (name) {
        funcObfStrings = name;
        console.log("[deobf] strings func (decl):", funcObfStrings);
        path.stop();
      }
    },
    VariableDeclarator(path) {
      if (funcObfStrings) return;
      const node = path.node;
      if (!t.isIdentifier(node.id)) return;
      if (!node.init || !t.isFunctionExpression(node.init)) return;
      if (!isStringsArrayFuncLike(node.init)) return;

      const name = node.id.name;
      const vd = path.parentPath.node;
      const code = t.isVariableDeclaration(vd)
        ? generate(vd).code
        : `const ${name} = ${generate(node.init).code};`;
      vm.runInContext(code, decryptCtx);
      path.parentPath.remove();
      funcObfStrings = name;
      console.log("[deobf] strings func (var):", funcObfStrings);
      path.stop();
    },
  });

  if (!funcObfStrings) {
    console.error("Strings function was not found");
    return;
  }

  traverse(ast, {
    FunctionDeclaration(path) {
      if (baseDecryptFunc) return;
      const name = ObfuscatedStrings.findBaseDecryptFunction(
        path,
        decryptCtx,
        funcObfStrings!
      );
      if (name) {
        baseDecryptFunc = name;
        console.log("[deobf] base decrypt:", baseDecryptFunc);
      }
    },
  });

  if (!baseDecryptFunc) {
    console.error("Base decrypt function was not found");
    return;
  }

  traverse(ast, {
    CallExpression(path) {
      if (foundShuffle) return;
      const ok = ObfuscatedStrings.shuffleObfuscatedStrings(
        path,
        decryptCtx,
        funcObfStrings!
      );
      if (ok) {
        foundShuffle = true;
      }
    },
  });
  console.log("[deobf] shuffler executed:", foundShuffle);

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
  console.log("[deobf] wrappers found:", Array.from(decryptFuncNames));

  for (const b of wrapperBindings) {
    DecryptStrings.decryptMapKeysByBinding(b, decryptCtx);
  }

  const namesForEval = new Set<string>(decryptFuncNames);
  namesForEval.add(baseDecryptFunc!);
  DecryptStrings.decryptCallsByName(ast, namesForEval, decryptCtx);

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

  traverse(ast, {
    CallExpression(path) {
      SimplifyIndexing.simplifyUnwrapOrElse(path);
    },
  });

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