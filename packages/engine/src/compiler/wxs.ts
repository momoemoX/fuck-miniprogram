import ts from 'typescript';

const globals = new Set([
  'undefined',
  'NaN',
  'Infinity',
  'module',
  'require',
  'arguments',
  'console',
  'Date',
  'Number',
  'Math',
  'JSON',
  'getDate',
  'getRegExp',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent'
]);

function propertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) &&
      parent.name === node)
  );
}

function hiddenGlobals(file: ts.SourceFile): string[] {
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true, allowNonTsExtensions: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => (name === file.fileName ? file : undefined);
  host.fileExists = name => name === file.fileName;
  host.readFile = name => (name === file.fileName ? file.text : undefined);
  const checker = ts.createProgram([file.fileName], options, host).getTypeChecker();
  const hidden = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !globals.has(node.text)) {
      const parent = node.parent;
      const symbol = ts.isShorthandPropertyAssignment(parent)
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(node);
      if (!propertyName(node) && !symbol?.declarations?.some(declaration => declaration !== file && declaration.getSourceFile() === file))
        hidden.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...hidden];
}

export function compileWxs(source: string): string {
  const file = ts.createSourceFile('/module.wxs.js', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const identifiers = new Set<string>();
  const collect = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.ThisKeyword) throw new SyntaxError('WXS does not support this');
    if (
      ts.isIdentifier(node) &&
      node.text === 'require' &&
      !propertyName(node) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    )
      throw new SyntaxError('WXS require is only available in static calls');
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const dependency = node.arguments[0];
      if (node.arguments.length !== 1 || !dependency || !ts.isStringLiteral(dependency))
        throw new SyntaxError('WXS require expects a string literal');
      if (!dependency.text.endsWith('.wxs')) throw new SyntaxError('WXS require expects a .wxs file');
    }
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const hidden = hiddenGlobals(file);
  const name = (base: string) => {
    while (identifiers.has(base)) base += '_';
    identifiers.add(base);
    return base;
  };
  const property = name('__fmp_property');
  const call = name('__fmp_call');
  const transformed = ts.transform(file, [
    context => {
      const helper = (name: string, args: ts.Expression[]) =>
        ts.factory.createCallExpression(ts.factory.createIdentifier(name), undefined, args);
      const write = (node: ts.Node) => {
        const parent = node.parent;
        return (
          parent &&
          ((ts.isBinaryExpression(parent) &&
            parent.left === node &&
            parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
            ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
              (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
            ts.isDeleteExpression(parent) ||
            ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node))
        );
      };
      const expression = (node: ts.Expression) => ts.visitNode(node, visit) as ts.Expression;
      const visit: ts.Visitor = node => {
        if (ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)) {
          const member = node.expression;
          return ts.factory.createCallExpression(
            helper(call, [expression(member.expression), expression(member.argumentExpression)]),
            undefined,
            node.arguments.map(expression)
          );
        }
        if (!write(node)) {
          if (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor')
            return helper(property, [expression(node.expression), ts.factory.createStringLiteral('constructor')]);
          if (ts.isElementAccessExpression(node))
            return helper(property, [expression(node.expression), expression(node.argumentExpression)]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return root => ts.visitNode(root, visit) as ts.SourceFile;
    }
  ]);
  try {
    const body = ts.createPrinter().printFile(transformed.transformed[0]);
    return `(function (${[property, call, ...hidden].join(', ')}) {\n${body}\n})(__FMP__.wxsProperty, __FMP__.wxsCall);`;
  } finally {
    transformed.dispose();
  }
}
