import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { v2 as cloudinary } from 'cloudinary'

const uploadDir = path.resolve(process.cwd(), 'uploads')

export function cloudinaryReady() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
}

export async function storePdf(buffer, filename) {
  await mkdir(uploadDir, { recursive: true })
  const stem = String(filename || 'checklist').replace(/[^\w.-]+/g, '-').replace(/\.pdf$/i, '').slice(0, 60)
  const safe = `${Date.now()}-${stem || 'checklist'}.pdf`
  await writeFile(path.join(uploadDir, safe), buffer)
  const base = (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '')
  return `${base}/uploads/${safe}`
}

export async function removeStoredPdf(url) {
  const base = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '')
  if (!url || !base || !String(url).startsWith(`${base}/uploads/`)) return
  let name = ''
  try {
    name = path.basename(new URL(url).pathname)
  } catch {
    return
  }
  if (!/^[\w.-]+\.pdf$/i.test(name)) return
  await unlink(path.join(uploadDir, name)).catch(() => {})
}

export async function storeUpload(file) {
  const folder = process.env.CLOUDINARY_FOLDER || 'j-homes'
  if (cloudinaryReady()) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    })
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: 'auto' },
        (error, uploaded) => (error ? reject(error) : resolve(uploaded)),
      )
      stream.end(file.buffer)
    })
    return {
      url: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type,
      width: result.width || 0,
      height: result.height || 0,
      bytes: result.bytes || file.size,
      folder,
    }
  }

  await mkdir(uploadDir, { recursive: true })
  const safe = `${Date.now()}-${file.originalname.replace(/[^\w.]+/g, '-')}`
  await writeFile(path.join(uploadDir, safe), file.buffer)
  const base = (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '')
  return {
    url: `${base}/uploads/${safe}`,
    publicId: safe,
    resourceType: file.mimetype.startsWith('video') ? 'video' : 'image',
    width: 0,
    height: 0,
    bytes: file.size,
    folder: 'local',
  }
}
