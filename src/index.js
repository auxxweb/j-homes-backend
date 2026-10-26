import dotenv from 'dotenv'
dotenv.config({ override: true })
import cors from 'cors'
import express from 'express'
import path from 'node:path'
import { connectDb } from './db.js'
import { Entry, Page, Site } from './models.js'
import { syncCloudinaryLibrary, upsertMediaFromContent } from './media-library.js'
import { apiRouter } from './routes.js'
import { seedDemoLeads, seedIfEmpty } from './seed.js'

const app = express()
const port = Number(process.env.PORT || 4000)
const origins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:5174,http://localhost:5175,https://www.jhomes.in,https://jhomes.in,https://admin.jhomes.in')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

function isAllowedOrigin(origin) {
  if (!origin) return true
  if (origins.includes(origin)) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === 'jhomes.in' || hostname.endsWith('.jhomes.in')
  } catch {
    return false
  }
}

app.use(
  cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin))
    },
  }),
)
app.use(express.json({ limit: '8mb' }))
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')))
app.get('/api/health', (_req, res) => res.json({ ok: true }))
app.use('/api', apiRouter())

app.use((error, _req, res, _next) => {
  console.error(error)
  res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' })
})

await connectDb()
await seedIfEmpty()
await seedDemoLeads()
const home = await Site.findOne({ slug: 'j-homes' })
if (home) {
  const [pages, entries] = await Promise.all([Page.find({ site: home._id }), Entry.find({ site: home._id })])
  await upsertMediaFromContent(home, pages, entries)
  await syncCloudinaryLibrary(home._id).catch((error) => console.log(error?.message || 'Cloudinary library sync skipped.'))
}
app.listen(port, () => {
  console.log(`Admin API listening on http://localhost:${port}`)
})
