import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import OpenAI from 'openai'
import { extractText } from 'unpdf'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { KnowledgeChunk, KnowledgeDoc } from './models.js'

const root = path.resolve(process.cwd(), 'knowledge-files')
const extensions = new Set(['pdf', 'docx', 'txt', 'md', 'csv', 'xlsx', 'xls'])
const textLimit = 180_000

export function extensionOf(filename) {
  return String(filename || '').toLowerCase().split('.').pop() || ''
}

export function acceptedFile(filename) {
  return extensions.has(extensionOf(filename))
}

export function openai() {
  const key = process.env.OPENAI_API_KEY || ''
  if (!key || key.startsWith('PASTE') || key.includes('your-key')) return null
  return new OpenAI({ apiKey: key })
}

export function publicDoc(doc) {
  return {
    _id: doc._id,
    title: doc.title,
    filename: doc.filename,
    mime: doc.mime,
    bytes: doc.bytes,
    status: doc.status,
    error: doc.error,
    note: doc.note,
    chunkCount: doc.chunkCount,
    createdAt: doc.createdAt,
  }
}

export function storedPath(storedName) {
  const full = path.resolve(root, path.basename(String(storedName || '')))
  if (!full.startsWith(`${root}${path.sep}`)) throw new Error('Invalid file.')
  return full
}

export async function saveKnowledgeFile(storedName, buffer) {
  await mkdir(root, { recursive: true })
  await writeFile(storedPath(storedName), buffer)
}

export async function deleteKnowledgeFile(storedName) {
  if (!storedName) return
  await rm(storedPath(storedName), { force: true })
}

function clean(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function pagesFromText(text, page = '') {
  return [{ page: String(page || ''), text: clean(text) }].filter((item) => item.text)
}

async function pagesFromPdf(buffer) {
  const extracted = await extractText(new Uint8Array(buffer), { mergePages: false })
  const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text]
  return pages
    .map((text, index) => ({ page: String(index + 1), text: clean(text) }))
    .filter((item) => item.text)
}

async function pagesFromSheet(buffer) {
  const book = XLSX.read(buffer, { type: 'buffer' })
  return book.SheetNames.map((name) => ({
    page: name,
    text: clean(XLSX.utils.sheet_to_csv(book.Sheets[name])),
  })).filter((item) => item.text)
}

export async function readPages(filename, buffer) {
  const ext = extensionOf(filename)
  if (ext === 'pdf') return pagesFromPdf(buffer)
  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer })
    return pagesFromText(result.value)
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return pagesFromSheet(buffer)
  if (ext === 'txt' || ext === 'md') return pagesFromText(buffer.toString('utf8'))
  throw new Error('Save Word files as .docx. PDF, Excel, CSV and text files are also accepted.')
}

function chunkPages(pages) {
  const size = 1400
  const overlap = 200
  const chunks = []
  let used = 0
  let truncated = false
  for (const page of pages) {
    const text = page.text
    if (used >= textLimit) {
      truncated = true
      break
    }
    const room = textLimit - used
    const source = text.length > room ? text.slice(0, room) : text
    if (source.length < text.length) truncated = true
    used += source.length
    if (source.length <= size) {
      chunks.push({ page: page.page, text: source })
      continue
    }
    for (let index = 0; index < source.length; index += size - overlap) {
      const slice = source.slice(index, index + size).trim()
      if (slice.length > 40) chunks.push({ page: page.page, text: slice })
      if (index + size >= source.length) break
    }
  }
  return { chunks, truncated }
}

async function embedTexts(client, texts) {
  const model = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small'
  const vectors = []
  for (let index = 0; index < texts.length; index += 64) {
    const batch = texts.slice(index, index + 64)
    const response = await client.embeddings.create({ model, input: batch })
    for (const item of response.data) vectors.push(item.embedding)
  }
  return vectors
}

export async function indexDocument(id) {
  const doc = await KnowledgeDoc.findById(id)
  if (!doc) return
  doc.status = 'processing'
  doc.error = ''
  doc.note = ''
  await doc.save()
  try {
    const client = openai()
    if (!client) throw new Error('Add OPENAI_API_KEY on the server before documents can be read.')
    const buffer = await readFile(storedPath(doc.storedName))
    const pages = await readPages(doc.filename, buffer)
    const { chunks, truncated } = chunkPages(pages)
    if (!chunks.length) throw new Error('This file has no readable text. A scanned PDF needs to be exported with real text.')
    const vectors = await embedTexts(client, chunks.map((item) => item.text))
    await KnowledgeChunk.deleteMany({ document: doc._id })
    await KnowledgeChunk.insertMany(chunks.map((item, index) => ({
      site: doc.site,
      document: doc._id,
      title: doc.title,
      page: item.page,
      text: item.text,
      embedding: vectors[index],
    })))
    doc.status = 'ready'
    doc.chunkCount = chunks.length
    doc.note = truncated ? 'Only the first part of this file was read.' : ''
    await doc.save()
  } catch (error) {
    doc.status = 'failed'
    doc.chunkCount = 0
    doc.error = safeError(error)
    await doc.save()
    await KnowledgeChunk.deleteMany({ document: doc._id })
  }
}

export function cosine(left, right) {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm)
  return denom ? dot / denom : 0
}

export async function libraryState(siteId) {
  const docs = await KnowledgeDoc.find({ site: siteId }).select('status')
  if (!docs.length) return 'empty'
  if (docs.some((item) => item.status === 'ready')) return 'ready'
  if (docs.some((item) => item.status === 'processing')) return 'processing'
  return 'failed'
}

export async function searchPassages(siteId, question) {
  const state = await libraryState(siteId)
  if (state !== 'ready') return { state, passages: [] }
  const client = openai()
  if (!client) throw new Error('Add OPENAI_API_KEY on the server before the assistant can answer.')
  const [embedded] = await embedTexts(client, [question])
  const chunks = await KnowledgeChunk.find({ site: siteId }).select('title page text embedding')
  const ranked = chunks
    .map((item) => ({
      title: item.title,
      page: item.page,
      text: item.text,
      score: cosine(embedded, item.embedding || []),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .filter((item) => item.score > 0.18)
  return { state, passages: ranked }
}

export function calculate(expression) {
  const input = String(expression || '').replace(/\s+/g, '')
  if (!input || !/^[\d+\-*/().]+$/.test(input)) throw new Error('Use only numbers and + - * / ( ).')
  let index = 0
  const peek = () => input[index]
  const number = () => {
    const start = index
    if (peek() === '-' && (index === 0 || '+-*/('.includes(input[index - 1] || ''))) index += 1
    while ((peek() >= '0' && peek() <= '9') || peek() === '.') index += 1
    const raw = input.slice(start, index)
    if (!raw || raw === '-' || raw === '.') throw new Error('The expression is not a valid calculation.')
    return Number(raw)
  }
  const factor = () => {
    if (peek() === '(') {
      index += 1
      const value = expr()
      if (peek() !== ')') throw new Error('The expression is not a valid calculation.')
      index += 1
      return value
    }
    return number()
  }
  const term = () => {
    let value = factor()
    while (peek() === '*' || peek() === '/') {
      const operator = peek()
      index += 1
      const right = factor()
      if (operator === '/' && right === 0) throw new Error('Cannot divide by zero.')
      value = operator === '*' ? value * right : value / right
    }
    return value
  }
  const expr = () => {
    let value = term()
    while (peek() === '+' || peek() === '-') {
      const operator = peek()
      index += 1
      const right = term()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }
  const value = expr()
  if (index !== input.length || !Number.isFinite(value)) throw new Error('The expression is not a valid calculation.')
  return Math.round(value * 100) / 100
}

export function safeError(error) {
  const message = error?.error?.message || error?.message || 'The file could not be read.'
  return String(message).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-…').slice(0, 400)
}

export async function removeDocument(doc) {
  await KnowledgeChunk.deleteMany({ document: doc._id })
  await deleteKnowledgeFile(doc.storedName)
  await doc.deleteOne()
}
