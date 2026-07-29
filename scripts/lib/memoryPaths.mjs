import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultMemoryDbPath() {
  if (process.env.BENTO_MEMORY_DB) return process.env.BENTO_MEMORY_DB
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library/Application Support/com.romadev.bento', 'memory.sqlite3')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData/Roaming'), 'com.romadev.bento', 'memory.sqlite3')
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'com.romadev.bento', 'memory.sqlite3')
}

export const sqliteBinary = () => process.env.BENTO_MEMORY_SQLITE_BIN || 'sqlite3'
