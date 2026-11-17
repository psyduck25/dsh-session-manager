/**
 * 插件的持久状态：`$DSH_HOME/session-manager/state.json`。
 *
 * 结构（只存插件自己的数据）：
 *   {
 *     version: 1,
 *     settings: { bufferHours },
 *     locks:    [sessionId],          // 锁定后禁止删除
 *     buffer:   [entry],              // 删除缓冲站
 *     updatedAt
 *   }
 *
 * entry = {
 *   sessionId, title, workspaceId, workspaceTitle,
 *   deletedAt,                      // 进入缓冲站的时间
 *   expiresAt,                      // 到期后彻底删除
 *   pending, note, noteDetail       // 到期但删不掉时（会话还在跑）的原因代码与细节
 * }
 *
 * 为什么不写进 `cordis.patch.yml`：这些是用户点界面产生的运行数据，不是插件配置；
 * 写进配置层会让每次点按钮都变成一次配置编辑。读取时任何损坏都退回默认值，
 * 绝不让插件因为一个坏文件起不来。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 没写过状态文件时使用的值。 */
export const DEFAULTS = Object.freeze({
  bufferHours: 24,
})

/** 界面可改的范围：0 表示二次确认后立即彻底删除，720 小时 = 30 天。 */
export const LIMITS = Object.freeze({
  bufferHours: { min: 0, max: 720, step: 1 },
})

export const STATE_VERSION = 1

/** `$DSH_HOME`，与 DSH 自身的解析顺序一致：显式覆盖优先，否则 `~/.dsh`。 */
export function resolveDshHome(env = process.env) {
  const override = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return override === '' ? path.join(os.homedir(), '.dsh') : path.resolve(override)
}

export function stateFile(home) {
  return path.join(home, 'session-manager', 'state.json')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 把任意候选值收成合法设置。
 *
 * 这里不做报错、只做收敛：状态文件是插件自己的运行数据，用户改坏了、被别的程序写坏了，
 * 都应该退回默认值继续用，而不是让设置页打不开。超出范围的数字直接掐到边界。
 */
export function normalizeSettings(candidate) {
  const input = isRecord(candidate) ? candidate : {}
  const settings = { ...DEFAULTS }
  const limit = LIMITS.bufferHours
  const raw = input.bufferHours
  if (raw === undefined || raw === null) return settings
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return settings
  settings.bufferHours = clamp(Math.round(value), limit.min, limit.max)
  return settings
}

function normalizeEntry(entry) {
  if (!isRecord(entry)) return undefined
  if (typeof entry.sessionId !== 'string' || entry.sessionId === '') return undefined
  const deletedAt = Number.isFinite(entry.deletedAt) ? Number(entry.deletedAt) : Date.now()
  // 缺失 expiresAt 时绝对不能回落到 deletedAt：那样条目立刻「已到期」，
  // 下一次巡检就会把一个本该还能回档的会话永久删掉。
  // 退回默认缓冲时长，宁可多留一会儿。
  const expiresAt = Number.isFinite(entry.expiresAt)
    ? Number(entry.expiresAt)
    : deletedAt + DEFAULTS.bufferHours * 3_600_000
  return {
    sessionId: entry.sessionId,
    title: typeof entry.title === 'string' ? entry.title : '',
    workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : '',
    workspaceTitle: typeof entry.workspaceTitle === 'string' ? entry.workspaceTitle : '',
    deletedAt,
    expiresAt,
    // 日志被搬到回收站之前的所在目录，以及搬了哪些文件；meta.json 丢了也能靠它还原。
    originalDir: typeof entry.originalDir === 'string' ? entry.originalDir : '',
    files: Array.isArray(entry.files) ? entry.files.filter((name) => typeof name === 'string') : [],
    pending: entry.pending === true,
    note: typeof entry.note === 'string' ? entry.note : '',
    noteDetail: typeof entry.noteDetail === 'string' ? entry.noteDetail : '',
  }
}

function normalize(candidate) {
  const input = isRecord(candidate) ? candidate : {}
  const settings = normalizeSettings(input.settings)
  const locks = Array.isArray(input.locks)
    ? input.locks.filter((id) => typeof id === 'string' && id !== '')
    : []
  const buffer = Array.isArray(input.buffer)
    ? input.buffer.map(normalizeEntry).filter((entry) => entry !== undefined)
    : []
  return { version: STATE_VERSION, settings, locks, buffer, updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : '' }
}

export function emptyState() {
  return { version: STATE_VERSION, settings: { ...DEFAULTS }, locks: [], buffer: [], updatedAt: '' }
}

/** 读状态文件；缺失或损坏时返回默认值。 */
export function readState(home) {
  const file = stateFile(home)
  if (!existsSync(file)) return emptyState()
  try {
    return normalize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyState()
  }
}

/** 原子写入（先写临时文件再替换），避免半个文件把状态弄坏。 */
export function writeState(home, candidate) {
  const state = normalize(candidate)
  state.updatedAt = new Date().toISOString()
  const file = stateFile(home)
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return state
}
