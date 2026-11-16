// @ts-check
// Syncs missing matchers, mod types, implicit/imbued stats, bulk-exchange items,
// and new league base types from the official Path of Exile Trade API into
// renderer/public/data/en/{items,stats}.ndjson.
//
// Usage: node renderer/scripts/update-trade-data.mjs
// Idempotent: safe to re-run after any game patch.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../public/data/en')
const STATS_PATH = path.join(DATA_DIR, 'stats.ndjson')
const ITEMS_PATH = path.join(DATA_DIR, 'items.ndjson')

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const TRADE_TYPES = new Set(['explicit', 'implicit', 'crafted', 'fractured', 'enchant', 'scourge'])
const NEW_STAT_TYPES = new Set(['implicit', 'imbued'])
const TRADE_ONLY_SUFFIX = /\s\([A-Z][a-z]+\)$/
const NEW_ITEM_CLASSES = {
  viscera: 'Viscera'
}

function toMatcherString (text) {
  return text.replace(/[+-]#/g, '#')
}

async function fetchTradeEndpoint (endpoint) {
  const res = await fetch(`https://www.pathofexile.com/api/trade/data/${endpoint}`, {
    headers: { 'User-Agent': USER_AGENT }
  })
  if (!res.ok) throw new Error(`Trade API /${endpoint} responded ${res.status}`)
  return res.json()
}

// 1. Update stats.ndjson
{
  const trade = await fetchTradeEndpoint('stats')
  const rawText = fs.readFileSync(STATS_PATH, 'utf-8')
  const eol = rawText.includes('\r\n') ? '\r\n' : '\n'
  const lines = rawText.split(/\r?\n/).filter(Boolean)
  const rows = lines.map(line => JSON.parse(line))

  const statsById = new Map()
  const knownMatchers = new Set()
  const knownRefs = new Set()

  rows.forEach((statOrGroup, row) => {
    const stats = ('stats' in statOrGroup) ? statOrGroup.stats : [statOrGroup]
    for (const stat of stats) {
      knownRefs.add(stat.ref)
      for (const m of stat.matchers ?? []) {
        knownMatchers.add(m.string)
        if (m.advanced) knownMatchers.add(m.advanced)
      }
      for (const ids of Object.values(stat.trade?.ids ?? {})) {
        for (const id of ids) {
          const key = id.slice(id.indexOf('.') + 1)
          const list = statsById.get(key) ?? []
          if (!list.some(e => e.stat === stat)) list.push({ stat, row })
          statsById.set(key, list)
        }
      }
    }
  })

  let matchersAdded = 0
  let modTypesAdded = 0
  let newStatsAdded = 0
  const changedRows = new Set()

  for (const group of trade.result) {
    if (!TRADE_TYPES.has(group.id)) continue
    for (const entry of group.entries) {
      if (TRADE_ONLY_SUFFIX.test(entry.text)) continue
      const key = entry.id.slice(entry.id.indexOf('.') + 1)
      const targets = statsById.get(key)
      if (!targets || targets.length !== 1) continue
      const { stat, row } = targets[0]

      const typeIds = (stat.trade.ids[group.id] ??= [])
      if (!typeIds.includes(entry.id)) {
        typeIds.push(entry.id)
        changedRows.add(row)
        modTypesAdded++
      }

      const matcher = toMatcherString(entry.text)
      if (!knownMatchers.has(matcher)) {
        stat.matchers.push({ string: matcher })
        knownMatchers.add(matcher)
        changedRows.add(row)
        matchersAdded++
      }
    }
  }

  for (const row of changedRows) {
    lines[row] = JSON.stringify(rows[row])
  }

  for (const group of trade.result) {
    if (!NEW_STAT_TYPES.has(group.id)) continue
    for (const entry of group.entries) {
      if (TRADE_ONLY_SUFFIX.test(entry.text)) continue
      const key = entry.id.slice(entry.id.indexOf('.') + 1)
      if (statsById.has(key)) continue
      const matcher = toMatcherString(entry.text)
      if (knownMatchers.has(matcher) || knownRefs.has(entry.text)) continue
      knownMatchers.add(matcher)
      knownRefs.add(entry.text)
      const stat = {
        ref: entry.text,
        better: 1,
        matchers: [{ string: matcher }],
        trade: { ids: { [group.id]: [entry.id] } }
      }
      lines.push(JSON.stringify(stat))
      statsById.set(key, [{ stat, row: lines.length - 1 }])
      newStatsAdded++
    }
  }

  fs.writeFileSync(STATS_PATH, lines.join(eol) + eol)
  console.log(`stats.ndjson: +${matchersAdded} matchers, +${modTypesAdded} mod types, +${newStatsAdded} new stats`)
}

// 2. Update items.ndjson
{
  const tradeItems = await fetchTradeEndpoint('items')
  const rawText = fs.readFileSync(ITEMS_PATH, 'utf-8')
  const eol = rawText.includes('\r\n') ? '\r\n' : '\n'
  const lines = rawText.split(/\r?\n/).filter(Boolean)
  const knownItems = new Set(lines.map(l => JSON.parse(l)).filter(i => i.namespace === 'ITEM').map(i => i.refName))

  let added = 0
  for (const group of tradeItems.result) {
    const category = NEW_ITEM_CLASSES[group.id]
    if (!category) continue
    for (const entry of group.entries) {
      if (entry.name || knownItems.has(entry.type)) continue
      knownItems.add(entry.type)
      lines.push(JSON.stringify({
        name: entry.type,
        refName: entry.type,
        namespace: 'ITEM',
        viscera: category === 'Viscera' ? true : undefined,
        craftable: { category },
        icon: '',
        w: 2,
        h: 2
      }))
      added++
    }
  }

  fs.writeFileSync(ITEMS_PATH, lines.join(eol) + eol)
  console.log(`items.ndjson: +${added} base types`)
}

