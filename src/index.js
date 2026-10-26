import dotenv from 'dotenv'
dotenv.config({ override: true })
import cors from 'cors'
import express from 'express'
import path from 'node:path'
import { connectDb } from './db.js'
import { apiRouter } from './routes.js'
import { seedIfEmpty } from './seed.js'

const app = express()
const port = Number(process.env.PORT || 4000)
const origins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:5174,http://localhost:5175')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

app.use(cors({ origin: origins }))
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
app.listen(port, () => {
  console.log(`Admin API listening on http://localhost:${port}`)
})
