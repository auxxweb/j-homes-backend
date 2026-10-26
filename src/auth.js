import jwt from 'jsonwebtoken'
import { User } from './models.js'

export function signUser(user) {
  return jwt.sign({ sub: String(user._id), email: user.email }, process.env.JWT_SECRET || 'dev-only-secret', {
    expiresIn: '7d',
  })
}

export function isSuper(user) {
  return user?.role === 'superadmin' || user?.role === 'admin'
}

export async function requireUser(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return res.status(401).json({ ok: false, error: 'Sign in required.' })
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-only-secret')
    const user = await User.findById(payload.sub).select('email name role')
    if (!user) return res.status(401).json({ ok: false, error: 'Sign in required.' })
    req.user = user
    next()
  } catch {
    return res.status(401).json({ ok: false, error: 'Sign in required.' })
  }
}
