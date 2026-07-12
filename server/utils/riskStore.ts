import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FileRisk } from '../../app/utils/risk'

export interface SavedRiskMap {
  repo: string
  number: string
  risks: FileRisk[]
  createdAt: string
}

// Latest risk map per resolved repo path + PR number; re-mapping overwrites.
const DIR = join(homedir(), '.differ')
const FILE = join(DIR, 'risks.json')

export function loadRiskMap(repo: string, number: string): SavedRiskMap | null {
  return loadAll().find((r) => r.repo === repo && r.number === number) ?? null
}

export function saveRiskMap(entry: SavedRiskMap): void {
  mkdirSync(DIR, { recursive: true })
  const rest = loadAll().filter((r) => !(r.repo === entry.repo && r.number === entry.number))
  writeFileSync(FILE, JSON.stringify([...rest, entry], null, 2))
}

function loadAll(): SavedRiskMap[] {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return []
  }
}
