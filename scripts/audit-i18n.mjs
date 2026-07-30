import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const uiProperties = new Set(['textContent', 'title', 'placeholder', 'aria-label'])
const uiHelperArguments = new Map([
  ['note', [0]],
  ['field', [0]],
  ['iconBtn', [1]],
  ['mkBtn', [1]],
  ['header', [0]],
  ['fillSelect', [1]],
  ['setStatus', [0]],
  ['setSourceActivity', [0]],
  ['showCommitStatus', [0]],
])
const translationCalls = new Set(['appT', 'taskT', 'i18nT', 't', 'catalogT'])
const naturalLanguage = /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2}/u
const roots = ['src/app', 'src/ui', 'src/panels']

const files = roots.flatMap(root => fs.readdirSync(root, { recursive: true })
  .filter(file => String(file).endsWith('.ts'))
  .map(file => path.join(root, String(file))))
const missing = []

const recordLiteral = (node, sourceFile) => {
  const value = ts.isStringLiteralLike(node)
    ? node.text
    : ts.isTemplateExpression(node)
      ? node.head.text + node.templateSpans.map(span => span.literal.text).join('')
      : null
  if (!value || !naturalLanguage.test(value)) return
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
  missing.push(`${sourceFile.fileName}:${line}: ${JSON.stringify(value)}`)
}

const record = (node, sourceFile) => {
  if (ts.isCallExpression(node)) {
    const name = ts.isIdentifier(node.expression) ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''
    if (translationCalls.has(name)) return
  }
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
    recordLiteral(node, sourceFile)
    return
  }
  if (ts.isConditionalExpression(node)) {
    record(node.whenTrue, sourceFile)
    record(node.whenFalse, sourceFile)
    return
  }
  ts.forEachChild(node, child => record(child, sourceFile))
}

for (const file of files) {
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) && uiProperties.has(node.left.name.text)) record(node.right, sourceFile)
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : ''
      if (uiProperties.has(name)) record(node.initializer, sourceFile)
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''
      for (const index of uiHelperArguments.get(name) ?? []) {
        if (node.arguments[index]) record(node.arguments[index], sourceFile)
      }
      if (name === 'setAttribute' && ts.isStringLiteral(node.arguments[0]) && uiProperties.has(node.arguments[0].text)) {
        if (node.arguments[1]) record(node.arguments[1], sourceFile)
      }
      if (name === 'showContextMenu' && node.arguments[2]) {
        const recordMenuLabels = (menuNode) => {
          if (ts.isArrayLiteralExpression(menuNode)) {
            menuNode.elements.forEach(recordMenuLabels)
            return
          }
          if (!ts.isObjectLiteralExpression(menuNode)) return
          menuNode.properties.forEach(property => {
            if (!ts.isPropertyAssignment(property)) return
            const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : ''
            if (propertyName === 'label') record(property.initializer, sourceFile)
          })
        }
        recordMenuLabels(node.arguments[2])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

if (missing.length) {
  console.error(`Found ${missing.length} untranslated visible UI strings:\n${missing.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`i18n audit passed: ${files.length} TypeScript UI files checked.`)
}

const forbidden = ['legacyT', 'localizePanel', 'core/panelI18n', 'legacyPatterns']
const architectureFiles = [...files, 'src/core/i18n.ts', 'src/i18n/index.ts']
const architectureHits = architectureFiles.flatMap(file => {
  const source = fs.readFileSync(file, 'utf8')
  return forbidden.filter(token => source.includes(token)).map(token => `${file}: forbidden ${token}`)
})
const legacyModule = 'src/core/panelI18n.ts'
if (fs.existsSync(legacyModule)) architectureHits.push(`${legacyModule}: legacy module must not exist`)

for (const locale of ['es', 'en']) {
  const catalogFile = `src/i18n/${locale}.json`
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'))
  for (const legacySection of ['dynamic', 'legacy', 'legacyPatterns']) {
    if (Object.hasOwn(catalog, legacySection)) architectureHits.push(`${catalogFile}: forbidden ${legacySection} section`)
    if (Object.hasOwn(catalog.panels ?? {}, legacySection)) architectureHits.push(`${catalogFile}: forbidden panels.${legacySection} section`)
  }
}
if (architectureHits.length) {
  console.error(`Legacy i18n architecture found:\n${architectureHits.join('\n')}`)
  process.exitCode = 1
}
