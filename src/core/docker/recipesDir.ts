// Recipes live in <recipesDir>/<projectKey>. Picking the project's recipe folder
// itself is an easy mistake that makes Bento look one level too deep.
export function recipesRootFor(picked: string, projectKey: string): string {
  const folder = picked.replace(/\/+$/, '')
  const separator = folder.lastIndexOf('/')
  const hasParent = separator > 0
  const isProjectRecipe = projectKey !== '' && hasParent && folder.slice(separator + 1) === projectKey
  if (!isProjectRecipe) return picked
  return folder.slice(0, separator)
}
