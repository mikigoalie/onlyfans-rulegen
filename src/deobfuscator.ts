import * as parser from "@babel/parser";
import traverse, { NodePath, Scope } from "@babel/traverse";
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

class StringsAndDecrypt {
  static findStringsArrayDecl(
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

  static findStringsArrayVar(
    path: NodePath<t.VariableDeclarator>,
    vmContext: vm.Context
  ): string | undefined {
    const node = path.node;
    if (!t.isIdentifier(node.id)) return;
    const name = node.id.name;
    const init = node.init;
    if (!init || !t.isFunctionExpression(init)) return;
    if (!isStringsArrayFuncLike(init)) return;
    const vd = path.parentPath.node;
    const code = t.isVariableDeclaration(vd)
      ? generate(vd).code
      : `const ${name} = ${generate(init).code};`;
    vm.runInContext(code, vmContext);
    // remove whole var decl if single declarator
    const varDeclPath = path.parentPath as NodePath<t.VariableDeclaration>;
    if (varDeclPath.node.declarations.length === 1) {
      varDeclPath.remove();
    } else {
      path.remove();
    }
    return name;
  }

  static findBaseDecryptFunction(
    path: NodePath<t.FunctionDeclaration>,
    vmContext: vm.Context,
    stringsFuncName: string
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
          t.isIdentifier(init.callee, { name: stringsFuncName })
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

  // Match wrapper: return f(pX +/- K, pY) in any arg order
  static isWrapperCallTo(
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
}

class WrappersReg {
  // map original wrapper name -> VM-registered unique name
  private map = new Map<string, string>();
  private counter = 0;

  public has(name: string) {
    return this.map.has(name);
  }
  public vmNameOf(name: string) {
    return this.map.get(name);
  }
  public names(): string[] {
    return Array.from(this.map.keys());
  }

  // Register wrapper function/arrow under a non-colliding VM name
  public registerWrapperFuncDecl(
    path: NodePath<t.FunctionDeclaration>,
    vmContext: vm.Context,
    stringsFuncName: string
  ): boolean {
    const node = path.node;
    if (!node.id) return false;
    const srcName = node.id.name;

    // Never shadow the strings-array function in VM
    const vmName = `__wrap_${srcName}_${++this.counter}`;
    const wrapperExpr = t.functionExpression(
      null,
      node.params,
      node.body,
      node.generator,
      node.async
    );
    const code = `const ${vmName} = ${generate(wrapperExpr).code};`;
    if (!StringsAndDecrypt.isWrapperCallTo(wrapperExpr, stringsFuncName)) {
      return false;
    }
    vm.runInContext(code, vmContext);
    this.map.set(srcName, vmName);
    // Remove original from AST
    path.remove();
    return true;
  }

  public registerWrapperVarDecl(
    path: NodePath<t.VariableDeclarator>,
    vmContext: vm.Context,
    baseDecryptName: string
  ): boolean {
    const node = path.node;
    if (!t.isIdentifier(node.id)) return false;
    const srcName = node.id.name;
    const init = node.init;
    if (!init) return false;

    let fnNode: t.FunctionExpression | t.ArrowFunctionExpression | null = null;
    if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
      fnNode = init;
    }
    if (!fnNode) return false;

    if (!StringsAndDecrypt.isWrapperCallTo(fnNode, baseDecryptName)) {
      return false;
    }

    const vmName = `__wrap_${srcName}_${++this.counter}`;
    // Turn to function expression source if arrow
    const fnExpr =
      t.isArrowFunctionExpression(fnNode) && !t.isBlockStatement(fnNode.body)
        ? t.arrowFunctionExpression(fnNode.params, fnNode.body, fnNode.async)
        : fnNode;

    const code = `const ${vmName} = ${generate(fnExpr).code};`;
    vm.runInContext(code, vmContext);
    this.map.set(srcName, vmName);

    // Prune from AST
    const varDeclPath = path.parentPath as NodePath<t.VariableDeclaration>;
    if (varDeclPath.node.declarations.length === 1) {
      varDeclPath.remove();
    } else {
      path.remove();
    }
    return true;
  }
}

class DecryptEvaluator {
  constructor(
    private vmContext: vm.Context,
    private baseName: string,
    private wrapperVmNames: Map<string, string>
  ) {}

  // Replace k("..", num) / o("..", num) by literal via VM eval, using remapped callee
  public replaceCalls(ast: t.File | t.Program) {
    traverse(ast, {
      CallExpression: (path) => {
        const node = path.node;
        if (!t.isIdentifier(node.callee)) return;

        let vmCallee = "";
        if (node.callee.name === this.baseName) {
          vmCallee = this.baseName;
        } else {
          const mapped = this.wrapperVmNames.get(node.callee.name);
          if (!mapped) return;
          vmCallee = mapped;
        }

        // Clone node and swap callee to VM name
        const cloned = t.callExpression(t.identifier(vmCallee), [
          ...(node.arguments as t.Expression[]),
        ]);
        try {
          const code = generate(cloned).code;
          const value = vm.runInContext(code, this.vmContext);
          path.replaceWith(t.valueToNode(value));
        } catch {
          // skip if unsafe
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
  } = {};
  mapName: string | undefined;
  scope: Scope | undefined;

  public parseMap(path: NodePath<t.VariableDeclarator>): boolean | undefined {
    const node = path.node;
    if (!t.isObjectExpression(node.init)) return;
    if (!t.isIdentifier(node.id)) return;

    let hasBin = false;
    node.init.properties = node.init.properties.filter((prop) => {
      if (!t.isObjectProperty(prop)) return true;
      if (!t.isIdentifier(prop.key)) return true;
      const key = prop.key.name;

      if (t.isFunctionExpression(prop.value)) {
        const body = prop.value.body.body;
        if (body.length !== 1 || !t.isReturnStatement(body[0])) return true;
        const ret = body[0].argument;

        if (t.isBinaryExpression(ret)) {
          this.decryptionMap[key] = ret.operator;
          hasBin = true;
        } else if (t.isCallExpression(ret)) {
          if (ret.arguments.length === 3) {
            this.decryptionMap[key] = MapFuncType.CallThreeArg;
          } else if (ret.arguments.length === 1) {
            this.decryptionMap[key] = MapFuncType.CallOneArg;
          }
        }
      } else if (t.isStringLiteral(prop.value)) {
        this.decryptionMap[key] = prop.value.value;
      } else {
        return true;
      }
      return false;
    });

    if (hasBin) {
      this.mapName = node.id.name;
      this.scope = path.scope;
      return true;
    }
  }

  public replaceBinaryOpCalls() {
    this.scope?.traverse(
      this.scope.path.node,
      {
        CallExpression: (path: NodePath<t.CallExpression>) => {
          const node = path.node;
          if (!t.isMemberExpression(node.callee)) return;

          const { object, property } = node.callee;
          if (!t.isIdentifier(object, { name: this.mapName })) return;
          if (!t.isStringLiteral(property)) return;
          if (node.arguments.length !== 2) return;

          const op = this.decryptionMap[property.value];
          if (!isBinaryOperator(op)) return;

          path.replaceWith(
            t.binaryExpression(
              op,
              node.arguments[0] as t.Expression,
              node.arguments[1] as t.Expression
            )
          );
        },
      },
      this
    );
  }

  public replaceMapIndexing() {
    if (!this.mapName) return;
    this.scope?.crawl();
    const refs = this.scope?.getBinding(this.mapName)?.referencePaths;
    if (!refs) return;

    for (const ref of refs) {
      const mePath = ref.parentPath;
      const parent = mePath?.parentPath;
      if (!mePath || !t.isMemberExpression(mePath.node)) continue;
      if (!parent) continue;

      const { object, computed, property } = mePath.node;
      if (object !== ref.node || !computed || !t.isStringLiteral(property))
        continue;

      const val = this.decryptionMap[property.value];

      if (typeof val === "string" && !isBinaryOperator(val)) {
        mePath.replaceWith(t.valueToNode(val));
      } else if (typeof val !== "string" && t.isCallExpression(parent.node)) {
        if (parent.node.arguments.length !== 0) {
          const func = parent.node.arguments[0] as t.Expression;
          const args = parent.node.arguments.slice(1);
          parent.node.callee = func;
          parent.node.arguments = args;
        }
      }
    }
  }
}

class SimplifyIndexing {
  static simplifyUnwrapOrElse(path: NodePath<t.CallExpression>) {
    const node = path.node;
    if (!t.isCallExpression(node.callee)) return;
    if (node.arguments.length !== 3) return;

    const [obj, prop, alt] = node.arguments as t.Expression[];
    const member = this.multiMember(obj, prop);
    if (!member) return;

    const orNode = t.logicalExpression("||", member, alt);
    path.replaceWith(orNode);
    path.skip();
  }

  private static multiMember(
    object: t.Expression,
    property: t.Expression
  ): t.Expression | undefined {
    if (!t.isStringLiteral(property) || !property.value.includes(".")) {
      return t.memberExpression(object, property, true);
    }
    const parts = property.value.split(".");
    let cur: t.Expression | undefined;
    for (const p of parts) {
      const lit = t.stringLiteral(p);
      cur = cur
        ? t.memberExpression(cur, lit, true)
        : t.memberExpression(object, lit, true);
    }
    return cur;
  }
}

function deobfuscate(source: string) {
  const ast = parser.parse(source);
  const vmCtx = vm.createContext();

  let stringsFuncName: string | undefined;
  let baseDecryptName: string | undefined;
  let shuffled = false;

  // 1) Find strings-array function (decl or var)
  traverse(ast, {
    FunctionDeclaration(path) {
      if (stringsFuncName) return;
      const name = StringsAndDecrypt.findStringsArrayDecl(path, vmCtx);
      if (name) {
        stringsFuncName = name;
        path.stop();
      }
    },
  });
  if (!stringsFuncName) {
    traverse(ast, {
      VariableDeclarator(path) {
        if (stringsFuncName) return;
        const name = StringsAndDecrypt.findStringsArrayVar(path, vmCtx);
        if (name) {
          stringsFuncName = name;
          path.stop();
        }
      },
    });
  }
  if (!stringsFuncName) {
    console.error("Strings function was not found");
    return;
  }

  // 2) Find base decrypt function f
  traverse(ast, {
    FunctionDeclaration(path) {
      if (baseDecryptName) return;
      const name = StringsAndDecrypt.findBaseDecryptFunction(
        path,
        vmCtx,
        stringsFuncName!
      );
      if (name) baseDecryptName = name;
    },
  });
  if (!baseDecryptName) {
    console.error("Base decrypt function was not found");
    return;
  }

  // 3) Execute shuffler IIFE !(...)(stringsFuncName, N)
  traverse(ast, {
    CallExpression(path) {
      const node = path.node;
      if (node.arguments.length !== 2) return;
      if (!t.isIdentifier(node.arguments[0], { name: stringsFuncName! }))
        return;
      if (!t.isNumericLiteral(node.arguments[1])) return;

      const code = generate(t.expressionStatement(node)).code;
      try {
        vm.runInContext(code, vmCtx);
        shuffled = true;
        if (t.isUnaryExpression(path.parentPath.node)) {
          path.parentPath.remove();
        } else {
          path.remove();
        }
      } catch {
        // ignore
      }
    },
  });

  // 4) Find wrappers anywhere (decl or var), register in VM under unique names
  const wrappers = new WrappersReg();

  // Function declarations
  traverse(ast, {
    FunctionDeclaration(path) {
      // Don’t re-register base or strings func
      const id = path.node.id?.name;
      if (id === stringsFuncName || id === baseDecryptName) return;
      wrappers.registerWrapperFuncDecl(path, vmCtx, baseDecryptName!);
    },
  });

  // Variable declarators (fn expr or arrow)
  traverse(ast, {
    VariableDeclarator(path) {
      wrappers.registerWrapperVarDecl(path, vmCtx, baseDecryptName!);
    },
  });

  // 5) Replace decrypt calls by evaluating with VM, using remapped names
  const evaluator = new DecryptEvaluator(
    vmCtx,
    baseDecryptName!,
    // expose mapping for evaluator
    (wrappers as any).map as Map<string, string>
  );
  evaluator.replaceCalls(ast);

  // 6) Replace map arithmetic wrappers and strings
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

  // 7) Simplify unwrapOrElse-like
  traverse(ast, {
    CallExpression(path) {
      SimplifyIndexing.simplifyUnwrapOrElse(path);
    },
  });

  // 8) Bracket to dot when safe
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
  const outputPath = process.argv[3];
  writeFile(outputPath, code, (err) => {
    if (err) {
      console.error("Error writing file", err);
      return;
    }
    console.log(`Wrote file to ${outputPath}`);
  });
}

deobfuscate(readFileSync(process.argv[2], "utf8"));