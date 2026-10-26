import bcrypt from 'bcryptjs'
import { readFileSync } from 'node:fs'
import { Entry, Page, Site, User } from './models.js'

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

export async function seedIfEmpty() {
  const email = (process.env.ADMIN_EMAIL || 'admin@jhomes.in').toLowerCase()
  const password = process.env.ADMIN_PASSWORD || 'change-this-password'
  const existingUser = await User.findOne({ email })
  const passwordHash = await bcrypt.hash(password, 12)
  if (!existingUser) {
    await User.create({
      email,
      name: process.env.ADMIN_NAME || 'J Homes',
      passwordHash,
      role: 'superadmin',
    })
  } else {
    existingUser.passwordHash = passwordHash
    existingUser.name = process.env.ADMIN_NAME || existingUser.name
    existingUser.role = 'superadmin'
    await existingUser.save()
  }
  console.log(`Admin ready: ${email}`)

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
