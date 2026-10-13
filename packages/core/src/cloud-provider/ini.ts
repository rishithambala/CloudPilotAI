// Minimal ini parser for CLI config files (~/.aws/credentials, ~/.aws/config,
// ~/.oci/config). "[profile name]" headers (AWS config file form) map to the
// same section as "[name]".

export type IniSections = Record<string, Record<string, string>>

function sectionName(header: string): string {
  const section = header.trim()
  return section.startsWith("profile ") ? section.slice("profile ".length).trim() : section
}

export function parseIni(text: string): IniSections {
  const result: IniSections = {}
  let current: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue
    const header = line.match(/^\[(.+)\]$/)
    if (header) {
      current = sectionName(header[1])
      if (current.length > 0 && !result[current]) result[current] = {}
      continue
    }
    if (!current) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    result[current][line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return result
}

export function iniSectionNames(text: string): string[] {
  return Object.keys(parseIni(text)).filter((name) => name.length > 0)
}
