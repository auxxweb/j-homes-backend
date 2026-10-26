import bcrypt from 'bcryptjs'
import { Router } from 'express'
import multer from 'multer'
import { isSuper, requireUser, signUser } from './auth.js'
import { answerQuestion, safeError } from './agent.js'
import { acceptedFile, extensionOf, indexDocument, publicDoc, removeDocument, saveKnowledgeFile, storedPath } from './knowledge.js'
import { ChatMessage, ChatThread, Checklist, Enquiry, Entry, KnowledgeDoc, Media, Page, Site, User } from './models.js'
import { collectionNames, createBlankSite } from './seed.js'
import { absoluteAssetUrl, rewritePublicAssets, syncCloudinaryLibrary, upsertMediaFromContent } from './media-library.js'
import { removeStoredPdf, storePdf, storeUpload } from './uploads.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
})

const knowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
})

function staffMay(req) {
  if (req.method === 'GET' && req.path === '/sites') return true
  if ((req.method === 'GET' || req.method === 'POST') && /^\/sites\/[^/]+\/threads$/.test(req.path)) return true
  if ((req.method === 'GET' || req.method === 'DELETE') && /^\/threads\/[^/]+$/.test(req.path)) return true
  if (req.method === 'POST' && /^\/threads\/[^/]+\/messages$/.test(req.path)) return true
  return false
}

const collectionLabels = {
  projects: 'Projects',
  services: 'Services',
  journal: 'Journal',
  gallery: 'Gallery',
  comparisons: 'Before and after',
  journey: 'Journey',
  process: 'Process',
  land: 'Land',
  drawings: 'Drawings',
  approvals: 'Approvals',
  construction: 'Construction',
  interiors: 'Interiors',
  furniture: 'Furniture',
  quality: 'Quality',
  beyond: 'Beyond the build',
  hero: 'Hero',
  design: 'Design photo',
}

function assetMentioned(value, media) {
  if (typeof value !== 'string' || !value) return false
  const clean = value.split('?')[0]
  const url = String(media.url || '').split('?')[0]
  if (url && clean === url) return true
  const id = String(media.publicId || '')
  if (!id) return false
  return clean.includes(`/${id}.`) || clean.endsWith(`/${id}`) || clean.includes(`/${id}/`)
}

function walkAssets(value, visit, path = '') {
  if (typeof value === 'string') {
    if (value.includes('/upload/') || value.startsWith('/images/') || value.startsWith('/brand/') || value.startsWith('/brochure/') || value.includes('/uploads/')) {
      visit(value, path)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkAssets(item, visit, `${path}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => walkAssets(child, visit, path ? `${path}.${key}` : key))
  }
}

function placeDetail(path) {
  if (path.includes('before')) return 'Before'
  if (path.includes('after')) return 'After'
  if (path.includes('logo')) return 'Logo'
  if (path.includes('brochure')) return 'Brochure'
  return ''
}

function mediaPlacements(site, pages, entries) {
  const places = []
  const seen = new Set()
  function add(value, path, place) {
    const detail = place.detail || placeDetail(path)
    const key = `${place.href}|${place.label}|${detail}|${value}`
    if (seen.has(key)) return
    seen.add(key)
    places.push({ value, label: place.label, detail, href: place.href })
  }
  if (site?.settings) {
    walkAssets(site.settings, (value, path) => {
      add(value, path, { label: 'Site settings', detail: placeDetail(path) || 'Settings', href: '/settings' })
    })
  }
  for (const page of pages) {
    const label = page.title || page.path || 'Page'
    walkAssets(
      { title: page.title, kicker: page.kicker, lede: page.lede, sections: page.sections },
      (value, path) => add(value, path, { label, detail: 'Page', href: `/pages/${page._id}` }),
    )
    if (page.draft) {
      walkAssets(page.draft, (value, path) => add(value, path, { label, detail: 'Unpublished preview', href: `/pages/${page._id}` }))
    }
  }
  for (const entry of entries) {
    const data = entry.data || {}
    const name = data.title || data.location || data.headline || data.alt || entry.title || 'Untitled'
    const section = collectionLabels[entry.collection] || entry.collection
    walkAssets(data, (value, path) => {
      add(value, path, {
        label: `${section} · ${name}`,
        href: `/content/${entry.collection}?entry=${entry._id}`,
      })
    })
  }
  return places.map(({ value, label, detail, href }) => ({ value, label, detail, href }))
}

function publicSite(site, pages, entries) {
  const collections = {}
  for (const name of collectionNames) collections[name] = []
  for (const entry of entries) {
    if (!entry.published) continue
    if (!collections[entry.collection]) collections[entry.collection] = []
    collections[entry.collection].push(entry.data)
  }
  return {
    ok: true,
    site: {
      id: site._id,
      name: site.name,
      slug: site.slug,
      domain: site.domain,
      status: site.status,
    },
    settings: site.settings || {},
    pages: pages.map((page) => ({
      slug: page.slug,
      path: page.path,
      title: page.title,
      kicker: page.kicker,
      lede: page.lede,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      sections: page.sections || [],
    })),
    collections,
  }
}

function clip(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

function answersFrom(body) {
  if (!Array.isArray(body)) return null
  return body
    .slice(0, 80)
    .map((item) => ({
      section: clip(item?.section, 80),
      label: clip(item?.label, 160),
      value: clip(item?.value, 2000),
    }))
    .filter((item) => item.section || item.label || item.value)
}

function applyEnquiry(record, body) {
  if (body.name !== undefined) record.name = clip(body.name, 160)
  if (body.phone !== undefined) record.phone = clip(body.phone, 40)
  if (body.email !== undefined) record.email = clip(body.email, 160)
  if (body.location !== undefined) record.location = clip(body.location, 160)
  if (body.budget !== undefined) record.budget = clip(body.budget, 40)
  if (body.stage !== undefined) record.stage = clip(body.stage, 40)
  if (body.message !== undefined) record.message = clip(body.message, 4000)
  if (body.source !== undefined) record.source = clip(body.source, 40) || 'admin'
  if (body.status !== undefined) record.status = clip(body.status, 20) || 'new'
}

function applyChecklist(record, body) {
  if (body.name !== undefined) record.name = clip(body.name, 160)
  if (body.phone !== undefined) record.phone = clip(body.phone, 40)
  if (body.location !== undefined) record.location = clip(body.location, 160)
  if (body.checklistDate !== undefined) record.checklistDate = clip(body.checklistDate, 40)
  if (body.signature !== undefined) record.signature = clip(body.signature, 160)
  if (body.pdfUrl !== undefined) record.pdfUrl = clip(body.pdfUrl, 2000)
  if (body.status !== undefined) record.status = clip(body.status, 20) || 'new'
  if (body.submittedAt !== undefined && clip(body.submittedAt, 40)) record.submittedAt = clip(body.submittedAt, 40)
  const answers = answersFrom(body.answers)
  if (answers) record.answers = answers
}

export function apiRouter() {
  const router = Router()

  router.use((req, res, next) => {
    if (req.path.startsWith('/auth') || req.path.startsWith('/public')) return next()
    requireUser(req, res, () => {
      if (isSuper(req.user) || staffMay(req)) return next()
      res.status(403).json({ ok: false, error: 'Only a super admin can do that.' })
    })
  })

  router.post('/auth/login', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase()
    const password = String(req.body?.password || '')
    const user = await User.findOne({ email })
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ ok: false, error: 'Email or password is incorrect.' })
    }
    return res.json({
      ok: true,
      token: signUser(user),
      user: { email: user.email, name: user.name, role: user.role },
    })
  })

  router.get('/auth/me', requireUser, (req, res) => {
    res.json({ ok: true, user: req.user })
  })

  router.get('/sites', requireUser, async (req, res) => {
    const sites = await Site.find().sort({ createdAt: 1 })
    if (!isSuper(req.user)) {
      return res.json({
        ok: true,
        sites: sites.map((site) => ({ _id: site._id, name: site.name, slug: site.slug, domain: site.domain })),
      })
    }
    res.json({ ok: true, sites })
  })

  router.post('/sites', requireUser, async (req, res) => {
    const name = String(req.body?.name || '').trim()
    if (!name) return res.status(400).json({ ok: false, error: 'A website name is required.' })
    const site = await createBlankSite({ name, domain: String(req.body?.domain || '').trim() })
    res.status(201).json({ ok: true, site })
  })

  router.patch('/sites/:id', requireUser, async (req, res) => {
    const site = await Site.findById(req.params.id)
    if (!site) return res.status(404).json({ ok: false, error: 'Website not found.' })
    const fields = ['name', 'domain', 'status', 'settings']
    for (const field of fields) {
      if (req.body?.[field] !== undefined) site[field] = req.body[field]
    }
    await site.save()
    res.json({ ok: true, site })
  })

  router.delete('/sites/:id', requireUser, async (req, res) => {
    const site = await Site.findById(req.params.id)
    if (!site) return res.status(404).json({ ok: false, error: 'Website not found.' })
    if (site.slug === 'j-homes') return res.status(400).json({ ok: false, error: 'The J Homes website stays in the panel.' })
    const docs = await KnowledgeDoc.find({ site: site._id })
    await Promise.all(docs.map((doc) => removeDocument(doc)))
    const threads = await ChatThread.find({ site: site._id }).select('_id')
    await Promise.all([
      Page.deleteMany({ site: site._id }),
      Entry.deleteMany({ site: site._id }),
      Enquiry.deleteMany({ site: site._id }),
      Checklist.deleteMany({ site: site._id }),
      Media.deleteMany({ site: site._id }),
      ChatMessage.deleteMany({ thread: { $in: threads.map((item) => item._id) } }),
      ChatThread.deleteMany({ site: site._id }),
      site.deleteOne(),
    ])
    res.json({ ok: true })
  })

  router.get('/sites/:id/pages', requireUser, async (req, res) => {
    const pages = await Page.find({ site: req.params.id }).sort({ order: 1 })
    res.json({ ok: true, pages })
  })

  router.post('/sites/:id/pages/restore', requireUser, async (req, res) => {
    await Page.updateMany({ site: req.params.id }, { $set: { draft: null } })
    const pages = await Page.find({ site: req.params.id }).sort({ order: 1 })
    res.json({ ok: true, pages })
  })

  router.post('/sites/:id/pages', requireUser, async (req, res) => {
    const count = await Page.countDocuments({ site: req.params.id })
    const title = String(req.body?.title || 'New page').trim()
    const slug = String(req.body?.slug || title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
    const page = await Page.create({
      site: req.params.id,
      slug: slug || `page-${count + 1}`,
      path: req.body?.path || `/${slug || `page-${count + 1}`}`,
      title,
      kicker: req.body?.kicker || 'Page',
      lede: req.body?.lede || '',
      seoTitle: req.body?.seoTitle || title,
      seoDescription: req.body?.seoDescription || '',
      order: count,
      sections: req.body?.sections || [],
    })
    res.status(201).json({ ok: true, page })
  })

  router.patch('/pages/:id', requireUser, async (req, res) => {
    const page = await Page.findById(req.params.id)
    if (!page) return res.status(404).json({ ok: false, error: 'Page not found.' })
    if (req.body?.draft && typeof req.body.draft === 'object') {
      page.draft = req.body.draft
      page.markModified('draft')
      await page.save()
      return res.json({ ok: true, page })
    }
    const fields = ['title', 'kicker', 'lede', 'seoTitle', 'seoDescription', 'path', 'slug', 'sections', 'order']
    for (const field of fields) {
      if (req.body?.[field] !== undefined) page[field] = req.body[field]
    }
    await page.save()
    res.json({ ok: true, page })
  })

  router.post('/pages/:id/publish', requireUser, async (req, res) => {
    const page = await Page.findById(req.params.id)
    if (!page) return res.status(404).json({ ok: false, error: 'Page not found.' })
    const draft = req.body?.draft && typeof req.body.draft === 'object' ? req.body.draft : page.draft
    if (!draft) return res.status(400).json({ ok: false, error: 'Nothing to publish.' })
    const fields = ['title', 'kicker', 'lede', 'seoTitle', 'seoDescription', 'path', 'slug', 'sections']
    for (const field of fields) {
      if (draft[field] !== undefined) page[field] = draft[field]
    }
    page.draft = null
    page.markModified('draft')
    page.markModified('sections')
    await page.save()
    res.json({ ok: true, page })
  })

  router.delete('/pages/:id', requireUser, async (req, res) => {
    await Page.findByIdAndDelete(req.params.id)
    res.json({ ok: true })
  })

  router.get('/sites/:id/entries', requireUser, async (req, res) => {
    const filter = { site: req.params.id }
    if (req.query.collection) filter.collection = String(req.query.collection)
    const entries = await Entry.find(filter).sort({ order: 1, createdAt: 1 })
    res.json({ ok: true, entries })
  })

  router.post('/sites/:id/entries', requireUser, async (req, res) => {
    const collection = String(req.body?.collection || '')
    if (!collection) return res.status(400).json({ ok: false, error: 'Choose a content type.' })
    const count = await Entry.countDocuments({ site: req.params.id, collection })
    const data = req.body?.data || {}
    const entry = await Entry.create({
      site: req.params.id,
      collection,
      slug: req.body?.slug || data.slug || `${collection}-${count + 1}`,
      title: req.body?.title || data.title || data.location || 'Untitled',
      order: count,
      published: req.body?.published !== false,
      data,
    })
    res.status(201).json({ ok: true, entry })
  })

  router.patch('/entries/:id', requireUser, async (req, res) => {
    const entry = await Entry.findById(req.params.id)
    if (!entry) return res.status(404).json({ ok: false, error: 'Item not found.' })
    if (req.body?.title !== undefined) entry.title = req.body.title
    if (req.body?.slug !== undefined) entry.slug = req.body.slug
    if (req.body?.published !== undefined) entry.published = req.body.published
    if (req.body?.order !== undefined) entry.order = req.body.order
    if (req.body?.data !== undefined) entry.data = req.body.data
    if (entry.data?.title) entry.title = entry.data.title
    else if (entry.data?.location) entry.title = entry.data.location
    await entry.save()
    res.json({ ok: true, entry })
  })

  router.delete('/entries/:id', requireUser, async (req, res) => {
    await Entry.findByIdAndDelete(req.params.id)
    res.json({ ok: true })
  })

  router.get('/sites/:id/checklists', requireUser, async (req, res) => {
    const checklists = await Checklist.find({ site: req.params.id }).sort({ createdAt: -1 })
    res.json({ ok: true, checklists })
  })

  router.post('/sites/:id/checklists', requireUser, async (req, res) => {
    const site = await Site.findById(req.params.id)
    if (!site) return res.status(404).json({ ok: false, error: 'Website not found.' })
    const checklist = new Checklist({ site: site._id, submittedAt: new Date().toISOString() })
    applyChecklist(checklist, req.body || {})
    if (!checklist.name || !checklist.phone) return res.status(400).json({ ok: false, error: 'Name and phone are required.' })
    await checklist.save()
    res.status(201).json({ ok: true, checklist })
  })

  router.patch('/checklists/:id', requireUser, async (req, res) => {
    const checklist = await Checklist.findById(req.params.id)
    if (!checklist) return res.status(404).json({ ok: false, error: 'Checklist not found.' })
    applyChecklist(checklist, req.body || {})
    if (!checklist.name || !checklist.phone) return res.status(400).json({ ok: false, error: 'Name and phone are required.' })
    await checklist.save()
    res.json({ ok: true, checklist })
  })

  router.delete('/checklists/:id', requireUser, async (req, res) => {
    const checklist = await Checklist.findByIdAndDelete(req.params.id)
    if (checklist?.pdfUrl) await removeStoredPdf(checklist.pdfUrl)
    res.json({ ok: true })
  })

  router.get('/sites/:id/enquiries', requireUser, async (req, res) => {
    const enquiries = await Enquiry.find({ site: req.params.id }).sort({ createdAt: -1 })
    res.json({ ok: true, enquiries })
  })

  router.post('/sites/:id/enquiries', requireUser, async (req, res) => {
    const site = await Site.findById(req.params.id)
    if (!site) return res.status(404).json({ ok: false, error: 'Website not found.' })
    const enquiry = new Enquiry({ site: site._id, source: 'admin' })
    applyEnquiry(enquiry, req.body || {})
    if (!enquiry.name || !enquiry.phone) return res.status(400).json({ ok: false, error: 'Name and phone are required.' })
    await enquiry.save()
    res.status(201).json({ ok: true, enquiry })
  })

  router.patch('/enquiries/:id', requireUser, async (req, res) => {
    const enquiry = await Enquiry.findById(req.params.id)
    if (!enquiry) return res.status(404).json({ ok: false, error: 'Enquiry not found.' })
    applyEnquiry(enquiry, req.body || {})
    if (!enquiry.name || !enquiry.phone) return res.status(400).json({ ok: false, error: 'Name and phone are required.' })
    await enquiry.save()
    res.json({ ok: true, enquiry })
  })

  router.delete('/enquiries/:id', requireUser, async (req, res) => {
    await Enquiry.findByIdAndDelete(req.params.id)
    res.json({ ok: true })
  })

  router.get('/sites/:id/media', requireUser, async (req, res) => {
    const siteId = req.params.id
    const [site, pages, entries] = await Promise.all([
      Site.findById(siteId),
      Page.find({ site: siteId }),
      Entry.find({ site: siteId }),
    ])
    if (site) await upsertMediaFromContent(site, pages, entries)
    await syncCloudinaryLibrary(siteId).catch(() => undefined)
    const media = await Media.find({ site: siteId }).sort({ createdAt: -1 })
    const placements = mediaPlacements(site, pages, entries)
    res.json({
      ok: true,
      media: media.map((item) => ({
        ...item.toObject(),
        url: absoluteAssetUrl(item.url),
        uses: placements
          .filter((place) => assetMentioned(place.value, item) || assetMentioned(absoluteAssetUrl(place.value), item))
          .map(({ label, detail, href }) => ({ label, detail, href })),
      })),
    })
  })

  router.post('/sites/:id/media', requireUser, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Choose an image or video.' })
    const stored = await storeUpload(req.file)
    const media = await Media.create({
      site: req.params.id,
      alt: String(req.body?.alt || ''),
      ...stored,
    })
    res.status(201).json({ ok: true, media })
  })

  router.delete('/media/:id', requireUser, async (req, res) => {
    await Media.findByIdAndDelete(req.params.id)
    res.json({ ok: true })
  })

  router.get('/public/:slug', async (req, res) => {
    const site = await Site.findOne({ slug: req.params.slug, status: 'published' })
    if (!site) return res.status(404).json({ ok: false, error: 'Website not found.' })
    const [pages, entries, media] = await Promise.all([
      Page.find({ site: site._id }).sort({ order: 1 }),
      Entry.find({ site: site._id }).sort({ order: 1 }),
      Media.find({ site: site._id }),
    ])
    res.set('Cache-Control', 'no-store')
    res.json(rewritePublicAssets(publicSite(site, pages, entries), media))
  })

  router.post('/public/:slug/checklists', async (req, res) => {
    const site = await Site.findOne({ slug: req.params.slug })
    if (!site) return res.status(404).json({ ok: false, error: 'Website not found.' })
    const name = String(req.body?.name || '').trim()
    const phone = String(req.body?.phone || '').trim()
    if (!name || !phone) return res.status(400).json({ ok: false, error: 'Name and phone are required.' })
    const answers = Array.isArray(req.body?.answers)
      ? req.body.answers.slice(0, 80).map((item) => ({
          section: String(item?.section || '').slice(0, 80),
          label: String(item?.label || '').slice(0, 160),
          value: String(item?.value || '').slice(0, 2000),
        }))
      : []
    let pdfUrl = ''
    const pdfBase64 = String(req.body?.pdfBase64 || '')
    if (pdfBase64) {
      const buffer = Buffer.from(pdfBase64, 'base64')
      if (buffer.length > 6_000_000) return res.status(400).json({ ok: false, error: 'The PDF is too large.' })
      if (buffer.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ ok: false, error: 'The checklist PDF was not valid.' })
      pdfUrl = await storePdf(buffer, name)
    }
    const checklist = await Checklist.create({
      site: site._id,
      name,
      phone,
      location: String(req.body?.location || '').trim(),
      checklistDate: String(req.body?.checklistDate || '').trim(),
      signature: String(req.body?.signature || '').trim(),
      answers,
      pdfUrl,
      submittedAt: String(req.body?.submittedAt || new Date().toISOString()),
    })
    res.status(201).json({ ok: true, id: checklist._id, pdfUrl })
  })

  router.post('/public/:slug/enquiries', async (req, res) => {
    const site = await Site.findOne({ slug: req.params.slug })
    if (!site) return res.status(404).json({ ok: false, error: 'Website not found.' })
    if (String(req.body?.website || '').trim()) return res.json({ ok: true })
    const name = String(req.body?.name || '').trim()
    const phone = String(req.body?.phone || '').trim()
    if (!name || !phone) return res.status(400).json({ ok: false, error: 'Name and phone are required.' })
    const enquiry = await Enquiry.create({
      site: site._id,
      name,
      phone,
      email: String(req.body?.email || '').trim(),
      location: String(req.body?.location || '').trim(),
      budget: String(req.body?.budget || '').trim(),
      stage: String(req.body?.stage || '').trim(),
      message: String(req.body?.message || '').trim(),
      source: String(req.body?.source || 'contact'),
    })
    res.status(201).json({ ok: true, id: enquiry._id })
  })

  router.get('/users', requireUser, async (_req, res) => {
    const users = await User.find().select('email name role createdAt').sort({ createdAt: 1 })
    res.json({ ok: true, users })
  })

  router.post('/users', requireUser, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase()
    const name = String(req.body?.name || '').trim()
    const password = String(req.body?.password || '')
    const role = req.body?.role === 'superadmin' ? 'superadmin' : 'staff'
    if (!name || !email.includes('@')) return res.status(400).json({ ok: false, error: 'Name and a valid email are required.' })
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Use a password of at least 8 characters.' })
    if (await User.exists({ email })) return res.status(400).json({ ok: false, error: 'That email is already used.' })
    const user = await User.create({ email, name, role, passwordHash: await bcrypt.hash(password, 12) })
    res.status(201).json({ ok: true, user: { _id: user._id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt } })
  })

  router.patch('/users/:id', requireUser, async (req, res) => {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ ok: false, error: 'User not found.' })
    if (req.body?.name !== undefined) user.name = String(req.body.name).trim() || user.name
    if (req.body?.role !== undefined) {
      if (String(user._id) === String(req.user._id)) return res.status(400).json({ ok: false, error: 'You cannot change your own role.' })
      user.role = req.body.role === 'superadmin' ? 'superadmin' : 'staff'
    }
    if (req.body?.password) {
      const password = String(req.body.password)
      if (password.length < 8) return res.status(400).json({ ok: false, error: 'Use a password of at least 8 characters.' })
      user.passwordHash = await bcrypt.hash(password, 12)
    }
    await user.save()
    res.json({ ok: true, user: { _id: user._id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt } })
  })

  router.delete('/users/:id', requireUser, async (req, res) => {
    if (String(req.params.id) === String(req.user._id)) return res.status(400).json({ ok: false, error: 'You cannot delete your own account.' })
    const threads = await ChatThread.find({ user: req.params.id }).select('_id')
    await ChatMessage.deleteMany({ thread: { $in: threads.map((item) => item._id) } })
    await ChatThread.deleteMany({ user: req.params.id })
    await User.findByIdAndDelete(req.params.id)
    res.json({ ok: true })
  })

  router.get('/sites/:id/documents', requireUser, async (req, res) => {
    const documents = await KnowledgeDoc.find({ site: req.params.id }).sort({ createdAt: -1 })
    res.json({ ok: true, documents: documents.map(publicDoc) })
  })

  router.post('/sites/:id/documents', requireUser, knowledgeUpload.single('file'), async (req, res) => {
    const site = await Site.findById(req.params.id)
    if (!site) return res.status(404).json({ ok: false, error: 'Website not found.' })
    if (!req.file) return res.status(400).json({ ok: false, error: 'Choose a PDF, Word, Excel or text file.' })
    if (!acceptedFile(req.file.originalname)) {
      return res.status(400).json({ ok: false, error: 'Use a PDF, .docx, Excel, CSV or text file.' })
    }
    const title = String(req.body?.title || '').trim() || req.file.originalname.replace(/\.[^.]+$/, '')
    const doc = await KnowledgeDoc.create({
      site: site._id,
      title,
      filename: req.file.originalname,
      mime: req.file.mimetype,
      storedName: 'pending',
      bytes: req.file.size,
      uploadedBy: req.user._id,
    })
    doc.storedName = `${doc._id}.${extensionOf(req.file.originalname)}`
    await doc.save()
    await saveKnowledgeFile(doc.storedName, req.file.buffer)
    res.status(201).json({ ok: true, document: publicDoc(doc) })
    indexDocument(doc._id).catch((error) => console.error(safeError(error)))
  })

  router.get('/documents/:id/file', requireUser, async (req, res) => {
    const doc = await KnowledgeDoc.findById(req.params.id)
    if (!doc) return res.status(404).json({ ok: false, error: 'Document not found.' })
    res.download(storedPath(doc.storedName), doc.filename)
  })

  router.post('/documents/:id/reindex', requireUser, async (req, res) => {
    const doc = await KnowledgeDoc.findById(req.params.id)
    if (!doc) return res.status(404).json({ ok: false, error: 'Document not found.' })
    res.json({ ok: true })
    indexDocument(doc._id).catch((error) => console.error(safeError(error)))
  })

  router.delete('/documents/:id', requireUser, async (req, res) => {
    const doc = await KnowledgeDoc.findById(req.params.id)
    if (!doc) return res.status(404).json({ ok: false, error: 'Document not found.' })
    await removeDocument(doc)
    res.json({ ok: true })
  })

  router.get('/sites/:id/threads', requireUser, async (req, res) => {
    const threads = await ChatThread.find({ site: req.params.id, user: req.user._id }).sort({ updatedAt: -1 })
    res.json({ ok: true, threads })
  })

  router.post('/sites/:id/threads', requireUser, async (req, res) => {
    const site = await Site.findById(req.params.id)
    if (!site) return res.status(404).json({ ok: false, error: 'Website not found.' })
    const thread = await ChatThread.create({
      site: site._id,
      user: req.user._id,
      title: String(req.body?.title || 'New chat').trim().slice(0, 80) || 'New chat',
    })
    res.status(201).json({ ok: true, thread })
  })

  router.get('/threads/:id', requireUser, async (req, res) => {
    const thread = await ownThread(req)
    if (!thread) return res.status(404).json({ ok: false, error: 'Chat not found.' })
    const messages = await ChatMessage.find({ thread: thread._id }).sort({ createdAt: 1 })
    res.json({ ok: true, thread, messages })
  })

  router.delete('/threads/:id', requireUser, async (req, res) => {
    const thread = await ownThread(req)
    if (!thread) return res.status(404).json({ ok: false, error: 'Chat not found.' })
    await ChatMessage.deleteMany({ thread: thread._id })
    await thread.deleteOne()
    res.json({ ok: true })
  })

  router.post('/threads/:id/messages', requireUser, async (req, res) => {
    const thread = await ownThread(req)
    if (!thread) return res.status(404).json({ ok: false, error: 'Chat not found.' })
    if (!allowChat(req.user._id)) return res.status(429).json({ ok: false, error: 'Wait a moment before asking again.' })
    const question = String(req.body?.content || '').trim().slice(0, 4000)
    if (!question) return res.status(400).json({ ok: false, error: 'Type a question.' })
    const history = await ChatMessage.find({ thread: thread._id }).sort({ createdAt: -1 }).limit(8)
    await ChatMessage.create({ thread: thread._id, role: 'user', content: question })
    if (thread.title === 'New chat') thread.title = question.slice(0, 80)
    thread.updatedAt = new Date()
    await thread.save()
    try {
      const answer = await answerQuestion({
        siteId: thread.site,
        question,
        history: history.reverse().map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content.slice(0, 4000) })),
      })
      const message = await ChatMessage.create({
        thread: thread._id,
        role: 'assistant',
        content: answer.content,
        sources: answer.sources,
      })
      res.json({ ok: true, message, thread })
    } catch (error) {
      const message = await ChatMessage.create({
        thread: thread._id,
        role: 'assistant',
        content: safeError(error),
        sources: [],
      })
      res.json({ ok: true, message, thread })
    }
  })

  return router
}

const chatHits = new Map()

function allowChat(userId) {
  const now = Date.now()
  const key = String(userId)
  const recent = (chatHits.get(key) || []).filter((time) => now - time < 60_000)
  if (recent.length >= 20) return false
  recent.push(now)
  chatHits.set(key, recent)
  return true
}

async function ownThread(req) {
  return ChatThread.findOne({ _id: req.params.id, user: req.user._id })
}
