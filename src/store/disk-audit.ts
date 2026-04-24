import { readdir, stat } from 'fs/promises'
import { join } from 'path'

export interface DiskAuditReport {
  dataDir: string
  totalBytes: number
  subdirs: Record<string, number>
  topFiles: Array<{ path: string; bytes: number }>
}

const TOP_N = 10

async function walk(dir: string, onFile: (path: string, bytes: number) => void): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, onFile)
    } else if (entry.isFile()) {
      try {
        const s = await stat(full)
        onFile(full, s.size)
      } catch { /* file vanished mid-walk — ignore */ }
    }
  }
}

export async function auditDataDir(dataDir: string): Promise<DiskAuditReport> {
  const report: DiskAuditReport = {
    dataDir,
    totalBytes: 0,
    subdirs: {},
    topFiles: [],
  }

  const allFiles: Array<{ path: string; bytes: number }> = []
  await walk(dataDir, (path, bytes) => {
    report.totalBytes += bytes
    allFiles.push({ path, bytes })
    // First path segment under dataDir is the subdir name
    const rel = path.slice(dataDir.length + 1)
    const firstSep = rel.indexOf('/')
    const bucket = firstSep === -1 ? '(root)' : rel.slice(0, firstSep)
    report.subdirs[bucket] = (report.subdirs[bucket] ?? 0) + bytes
  })

  report.topFiles = allFiles
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP_N)

  return report
}

export function formatAuditReport(r: DiskAuditReport): string {
  const mb = (b: number) => (b / 1024 / 1024).toFixed(2) + 'MB'
  const subdirsStr = Object.entries(r.subdirs)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}=${mb(v)}`)
    .join(' ')
  const topStr = r.topFiles
    .slice(0, 5)
    .map((f) => `${mb(f.bytes)} ${f.path}`)
    .join(' | ')
  return `[disk-audit] dir=${r.dataDir} total=${mb(r.totalBytes)} ${subdirsStr} top=[${topStr}]`
}
