export interface Bookmark {
  id: string
  url: string
  title: string
  group: string
}

export interface BookmarkGroup {
  group: string
  items: Bookmark[]
}

export function addBookmark(bookmarks: Bookmark[], b: Bookmark): Bookmark[] {
  return [...bookmarks.filter(x => x.id !== b.id), b]
}

export function removeBookmark(bookmarks: Bookmark[], id: string): Bookmark[] {
  return bookmarks.filter(b => b.id !== id)
}

export function isBookmarked(bookmarks: Bookmark[], url: string): boolean {
  return bookmarks.some(b => b.url === url)
}

export function groupBookmarks(bookmarks: Bookmark[]): BookmarkGroup[] {
  const groups = new Map<string, Bookmark[]>()
  for (const b of bookmarks) {
    const items = groups.get(b.group) ?? []
    items.push(b)
    groups.set(b.group, items)
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }))
}
