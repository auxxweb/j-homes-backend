import bcrypt from 'bcryptjs'
import { readFileSync } from 'node:fs'
import { Checklist, Enquiry, Entry, Page, Site, User } from './models.js'

const blankPages = [
  ['home', '/', 'Home', 'Home'],
  ['about', '/about', 'About', 'About'],
  ['services', '/services', 'Services', 'Services'],
  ['projects', '/projects', 'Projects', 'Projects'],
  ['process', '/process', 'Process', 'Process'],
  ['gallery', '/gallery', 'Gallery', 'Gallery'],
  ['journal', '/blog', 'Journal', 'Journal'],
  ['contact', '/contact', 'Contact', 'Contact'],
]

export const collectionNames = [
  'projects',
  'services',
  'journal',
  'gallery',
  'comparisons',
  'journey',
  'process',
  'land',
  'drawings',
  'approvals',
  'construction',
  'interiors',
  'furniture',
  'quality',
  'beyond',
  'hero',
  'design',
]

function loadSnapshot() {
  return JSON.parse(readFileSync(new URL('./seed/jhomes.json', import.meta.url), 'utf8'))
}

function entryTitle(collection, item, index) {
  return item.title || item.location || item.name || item.code || `${collection} ${index + 1}`
}

function entrySlug(collection, item, index) {
  return item.slug || `${collection}-${index + 1}`
}

async function ensureAdminUser() {
  const email = (process.env.ADMIN_EMAIL || 'admin@jhomes.in').toLowerCase()
  const password = process.env.ADMIN_PASSWORD || '123456'
  const existingUser = await User.findOne({ email })
  if (!existingUser) {
    await User.create({
      email,
      name: process.env.ADMIN_NAME || 'J Homes',
      passwordHash: await bcrypt.hash(password, 12),
      role: 'superadmin',
    })
    console.log(`Admin created: ${email}`)
    return
  }
  if (process.env.ADMIN_PASSWORD_RESET === 'true') {
    existingUser.passwordHash = await bcrypt.hash(password, 12)
    existingUser.name = process.env.ADMIN_NAME || existingUser.name
    existingUser.role = 'superadmin'
    await existingUser.save()
    console.log(`Admin password reset: ${email}`)
    return
  }
  console.log(`Admin ready: ${email}`)
}

export async function seedDemoLeads() {
  const site = await Site.findOne({ slug: 'j-homes' })
  if (!site) return
  if ((await Enquiry.countDocuments({ site: site._id })) === 0) {
    await Enquiry.insertMany([
      {
        site: site._id,
        name: 'Anjali Menon',
        phone: '9876543210',
        email: 'anjali.menon@example.com',
        location: 'Mulanthuruthy',
        budget: '80-120',
        stage: 'land',
        message: 'We have a 10 cent plot and want a G+1 home. Looking for a first meeting.',
        source: 'contact',
        status: 'new',
      },
      {
        site: site._id,
        name: 'Rahul Krishnan',
        phone: '9123456780',
        email: 'rahul.krishnan@example.com',
        location: 'Kochi',
        budget: '120-plus',
        stage: 'design',
        message: 'Need architectural drawings and a turnkey quote for a 2,200 sq.ft house.',
        source: 'contact',
        status: 'new',
      },
      {
        site: site._id,
        name: 'Sneha Thomas',
        phone: '9988776655',
        email: 'sneha.thomas@example.com',
        location: 'Chottanikkara',
        budget: '50-80',
        stage: 'interiors',
        message: 'House is built. We want kitchen, wardrobes and living room interiors.',
        source: 'contact',
        status: 'new',
      },
    ])
    console.log('Seeded 3 sample enquiries')
  }
  if ((await Checklist.countDocuments({ site: site._id })) === 0) {
    await Checklist.insertMany([
      {
        site: site._id,
        name: 'Vivek Nair',
        phone: '9000011111',
        location: 'Eruveli',
        checklistDate: '2026-10-12',
        signature: 'Vivek Nair',
        submittedAt: new Date().toISOString(),
        status: 'new',
        answers: [
          { section: 'Client', label: 'Name', value: 'Vivek Nair' },
          { section: 'Site', label: 'Location', value: 'Eruveli' },
          { section: 'Scope', label: 'Floors', value: 'G+1' },
        ],
      },
      {
        site: site._id,
        name: 'Meera Joseph',
        phone: '9000022222',
        location: 'Thiruvaniyoor',
        checklistDate: '2026-10-18',
        signature: 'Meera Joseph',
        submittedAt: new Date().toISOString(),
        status: 'new',
        answers: [
          { section: 'Client', label: 'Name', value: 'Meera Joseph' },
          { section: 'Site', label: 'Location', value: 'Thiruvaniyoor' },
          { section: 'Scope', label: 'Plot', value: '50 cent, ground floor' },
        ],
      },
      {
        site: site._id,
        name: 'Arun George',
        phone: '9000033333',
        location: 'Changanassery',
        checklistDate: '2026-10-21',
        signature: 'Arun George',
        submittedAt: new Date().toISOString(),
        status: 'new',
        answers: [
          { section: 'Client', label: 'Name', value: 'Arun George' },
          { section: 'Site', label: 'Location', value: 'Changanassery' },
          { section: 'Scope', label: 'Built-up', value: '3,500 sq.ft' },
        ],
      },
    ])
    console.log('Seeded 3 sample checklists')
  }
}

export async function seedIfEmpty() {
  await ensureAdminUser()

  if (await Site.exists({ slug: 'j-homes' })) return
  const snapshot = loadSnapshot()
  const site = await Site.create({
    name: snapshot.settings.name || 'J Homes',
    slug: 'j-homes',
    domain: 'https://www.jhomes.in',
    template: 'jhomes',
    status: 'published',
    settings: snapshot.settings,
  })
  await Page.insertMany(
    snapshot.pages.map((page, order) => ({
      site: site._id,
      order,
      ...page,
    })),
  )
  const entries = []
  for (const collection of collectionNames) {
    const items = snapshot.collections[collection] || []
    items.forEach((item, index) => {
      entries.push({
        site: site._id,
        collection,
        slug: entrySlug(collection, item, index),
        title: entryTitle(collection, item, index),
        order: index,
        published: true,
        data: item,
      })
    })
  }
  if (entries.length) await Entry.insertMany(entries)
  console.log(`Seeded ${site.name} with ${entries.length} content records`)
}

export async function createBlankSite({ name, domain }) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48)
  const site = await Site.create({
    name,
    slug: slug || `site-${Date.now()}`,
    domain: domain || '',
    template: 'blank',
    status: 'draft',
    settings: {
      name,
      tagline: '',
      promise: '',
      lines: [],
      experienceYears: 0,
      completedProjects: 0,
      area: { city: '', district: '', region: '', country: '' },
      contact: {
        phone: '',
        phoneDisplay: '',
        email: '',
        whatsapp: '',
        instagram: '',
        instagramName: '',
        facebook: '',
        facebookName: '',
        address: [],
        mapUrl: '',
        mapEmbed: '',
      },
      logo: { webp: '', png: '', width: 0, height: 0 },
      whatsappMessage: '',
      servicePlaces: [],
      navigation: {
        main: [
          { label: 'Projects', to: '/projects' },
          { label: 'Services', to: '/services' },
          { label: 'About', to: '/about' },
          { label: 'Process', to: '/process' },
          { label: 'Contact', to: '/contact' },
        ],
        mobile: [
          { label: 'Home', to: '/' },
          { label: 'Projects', to: '/projects' },
          { label: 'Services', to: '/services' },
          { label: 'About', to: '/about' },
          { label: 'Contact', to: '/contact' },
        ],
        footer: [
          { label: 'Projects', to: '/projects' },
          { label: 'Services', to: '/services' },
          { label: 'About', to: '/about' },
          { label: 'Journal', to: '/blog' },
          { label: 'Gallery', to: '/gallery' },
          { label: 'Contact', to: '/contact' },
        ],
      },
    },
  })
  await Page.insertMany(
    blankPages.map(([slugName, path, title, kicker], order) => ({
      site: site._id,
      slug: slugName,
      path,
      title,
      kicker,
      lede: '',
      seoTitle: title,
      seoDescription: '',
      order,
      sections: [],
    })),
  )
  return site
}
