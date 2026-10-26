import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'

export async function connectDb() {
  const uri = process.env.MONGODB_URI?.trim()
  if (uri) {
    await mongoose.connect(uri)
    console.log('Connected to MongoDB Atlas')
    return
  }
  const memory = await MongoMemoryServer.create()
  await mongoose.connect(memory.getUri())
  console.log('MONGODB_URI is empty. Using a temporary local database. Set MONGODB_URI to use Atlas.')
}
