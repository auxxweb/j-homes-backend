import { v2 as cloudinary } from 'cloudinary'
import { Media } from './models.js'
import { cloudinaryReady } from './uploads.js'

export function publicApiBase() {
  return (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '')
}

export function publicSiteBase() {
  return (process.env.PUBLIC_SITE_URL || 'https://www.jhomes.in').replace(/\/$/, '')
}

export function absoluteAssetUrl(value) {
  if (typeof value !== 'string' || !value) return value
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value
  if (value.startsWith('/uploads/')) return `${publicApiBase()}${value}`
  if (value.startsWith('/')) return `${publicSiteBase()}${value}`
  return value
}

export function walkAssets(value, visit) {
  if (typeof value === 'string') {
    if (value.includes('/upload/') || value.startsWith('/images/') || value.startsWith('/brand/') || value.startsWith('/brochure/') || value.includes('/uploads/')) {
      visit(value)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => walkAssets(item, visit))
    return
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((child) => walkAssets(child, visit))
  }
}

function rewriteValue(value, urls) {
  if (typeof value === 'string') return urls.get(value.split('?')[0]) || absoluteAssetUrl(value)
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, urls))
  if (value && typeof value === 'object') {
    const next = {}
    for (const [key, child] of Object.entries(value)) next[key] = rewriteValue(child, urls)
    return next
  }
  return value
}

export function rewritePublicAssets(payload, media) {
  const urls = new Map()
  for (const item of media) {
    if (item.url) urls.set(item.url.split('?')[0], item.url)
    const id = String(item.publicId || '')
    if (id) {
      urls.set(`/${id.replace(/^j-homes\//, '')}`, item.url)
    }
    const local = String(item.alt || '')
    if (local.startsWith('/')) urls.set(local, item.url)
  }
  return rewriteValue(payload, urls)
}

export async function upsertMediaFromContent(site, pages, entries) {
  const seen = new Set()
  const found = []
  function add(value) {
    const url = String(value || '').split('?')[0]
    if (!url || seen.has(url)) return
    seen.add(url)
    found.push(url)
  }
  walkAssets(site?.settings, add)
  for (const page of pages) {
    walkAssets(page, add)
  }
  for (const entry of entries) {
    walkAssets(entry.data, add)
  }
  const existing = await Media.find({ site: site._id })
  const byUrl = new Set(existing.map((item) => String(item.url || '').split('?')[0]))
  const byId = new Set(existing.map((item) => item.publicId).filter(Boolean))
  const inserts = []
  for (const url of found) {
    if (byUrl.has(url) || byUrl.has(absoluteAssetUrl(url))) continue
    const publicId = url.includes('/upload/') ? url.split('/upload/').pop()?.replace(/\.[^.]+$/, '') || '' : ''
    if (publicId && byId.has(publicId)) continue
    inserts.push({
      site: site._id,
      url: absoluteAssetUrl(url),
      publicId,
      resourceType: /\.(mp4|webm|mov)$/i.test(url) ? 'video' : 'image',
      alt: url.split('/').pop() || '',
      folder: 'j-homes',
    })
  }
  if (inserts.length) await Media.insertMany(inserts)
}

export async function syncCloudinaryLibrary(siteId) {
  if (!cloudinaryReady()) return
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  })
  const folder = process.env.CLOUDINARY_FOLDER || 'j-homes'
  let next = undefined
  const resources = []
  do {
    const page = await cloudinary.api.resources({
      type: 'upload',
      prefix: `${folder}/`,
      max_results: 500,
      next_cursor: next,
    })
    resources.push(...(page.resources || []))
    next = page.next_cursor
  } while (next)
  const existing = await Media.find({ site: siteId })
  const byId = new Set(existing.map((item) => item.publicId).filter(Boolean))
  const byUrl = new Set(existing.map((item) => item.url))
  const inserts = resources
    .filter((item) => !byId.has(item.public_id) && !byUrl.has(item.secure_url))
    .map((item) => ({
      site: siteId,
      url: item.secure_url,
      publicId: item.public_id,
      resourceType: item.resource_type || 'image',
      alt: item.public_id.split('/').pop() || '',
      width: item.width || 0,
      height: item.height || 0,
      bytes: item.bytes || 0,
      folder,
    }))
  if (inserts.length) await Media.insertMany(inserts)
}
