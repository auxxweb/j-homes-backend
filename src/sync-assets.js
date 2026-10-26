import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import dotenv from 'dotenv'
import mongoose from 'mongoose'
import { v2 as cloudinary } from 'cloudinary'
import { Entry, Media, Page, Site } from './models.js'

dotenv.config({ override: true })

const publicDir = path.resolve(process.cwd(), '../public')
const assetPattern = /\.(jpe?g|png|webp|gif|avif|mp4|webm|mov|pdf)$/i

function publicIdFor(localPath) {
  const clean = localPath.replace(/^\//, '').replace(/\.[^.]+$/, '')
  const ext = path.extname(localPath).slice(1).toLowerCase()
  return `j-homes/${clean}-${ext}`
}

async function filesUnder(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(full, rel)))
    else if (assetPattern.test(entry.name)) files.push(`/${rel}`)
  }
  return files
}

function rewrite(value, urls) {
  if (typeof value === 'string') return urls.get(value) || value
  if (Array.isArray(value)) return value.map((item) => rewrite(item, urls))
  if (value && typeof value === 'object') {
    const next = {}
    for (const [key, child] of Object.entries(value)) next[key] = rewrite(child, urls)
    return next
  }
  return value
}

async function uploadOne(localPath) {
  const file = path.join(publicDir, localPath.replace(/^\//, ''))
  if (!existsSync(file)) return null
  const result = await cloudinary.uploader.upload(file, {
    public_id: publicIdFor(localPath),
    overwrite: true,
    resource_type: 'auto',
    invalidate: true,
  })
  return {
    localPath,
    url: result.secure_url,
    publicId: result.public_id,
    resourceType: result.resource_type,
    width: result.width || 0,
    height: result.height || 0,
    bytes: result.bytes || 0,
  }
}

async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  async function run() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return results
}

const cloudName = process.env.CLOUDINARY_CLOUD_NAME
const apiKey = process.env.CLOUDINARY_API_KEY
const apiSecret = process.env.CLOUDINARY_API_SECRET
if (!cloudName || !apiKey || !apiSecret || /^\*+$/.test(apiSecret)) {
  console.error('Cloudinary API secret in backend/.env is missing or still masked. Paste the real secret, then run this again.')
  process.exit(1)
}

cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret })
try {
  await cloudinary.api.ping()
} catch (error) {
  console.error(error?.error?.message || error.message || 'Cloudinary rejected these credentials.')
  process.exit(1)
}

if (!process.env.MONGODB_URI?.trim()) {
  console.error('MONGODB_URI is empty. Atlas is required for this upload.')
  process.exit(1)
}

await mongoose.connect(process.env.MONGODB_URI)
const site = await Site.findOne({ slug: 'j-homes' })
if (!site) {
  console.error('J Homes is not in Atlas yet. Start the API once so the site is seeded, then run this again.')
  process.exit(1)
}

const localFiles = await filesUnder(publicDir)
console.log(`Uploading ${localFiles.length} files to Cloudinary`)
const uploaded = []
const failed = []
await pool(localFiles, 4, async (localPath, index) => {
  try {
    const item = await uploadOne(localPath)
    if (!item) {
      failed.push(localPath)
      return
    }
    uploaded.push(item)
    console.log(`${index + 1}/${localFiles.length} ${localPath}`)
  } catch (error) {
    failed.push(`${localPath}: ${error?.error?.message || error.message}`)
  }
})

const urls = new Map(uploaded.map((item) => [item.localPath, item.url]))
const brochure = urls.get('/brochure/j-homes-brochure.pdf')

const settings = rewrite(site.settings || {}, urls)
if (brochure) settings.brochure = brochure
site.settings = settings
site.markModified('settings')
await site.save()

const pages = await Page.find({ site: site._id })
for (const page of pages) {
  page.title = rewrite(page.title, urls)
  page.kicker = rewrite(page.kicker, urls)
  page.lede = rewrite(page.lede, urls)
  page.seoTitle = rewrite(page.seoTitle, urls)
  page.seoDescription = rewrite(page.seoDescription, urls)
  page.sections = rewrite(page.sections || [], urls)
  if (page.draft) page.draft = rewrite(page.draft, urls)
  page.markModified('sections')
  page.markModified('draft')
  await page.save()
}

const entries = await Entry.find({ site: site._id })
for (const entry of entries) {
  entry.data = rewrite(entry.data || {}, urls)
  entry.markModified('data')
  await entry.save()
}

await Media.deleteMany({ site: site._id })
if (uploaded.length) {
  await Media.insertMany(
    uploaded.map((item) => ({
      site: site._id,
      url: item.url,
      publicId: item.publicId,
      resourceType: item.resourceType,
      alt: path.basename(item.localPath),
      width: item.width,
      height: item.height,
      bytes: item.bytes,
      folder: 'j-homes',
    })),
  )
}

const stillLocal = await Entry.countDocuments({
  site: site._id,
  $or: [{ 'data.src': /^\// }, { data: { $regex: '"src":"/' } }],
})
console.log(`Uploaded ${uploaded.length}. Failed ${failed.length}. Media records ${uploaded.length}. Entries still mentioning a local src: ${stillLocal}.`)
if (failed.length) console.log(failed.join('\n'))
await mongoose.disconnect()
