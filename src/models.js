import mongoose from 'mongoose'

const { Schema } = mongoose

export const User = mongoose.model(
  'User',
  new Schema(
    {
      email: { type: String, required: true, unique: true, lowercase: true, trim: true },
      name: { type: String, required: true },
      passwordHash: { type: String, required: true },
      role: { type: String, default: 'staff' },
    },
    { timestamps: true },
  ),
)

export const Site = mongoose.model(
  'Site',
  new Schema(
    {
      name: { type: String, required: true },
      slug: { type: String, required: true, unique: true },
      domain: { type: String, default: '' },
      template: { type: String, default: 'blank' },
      status: { type: String, default: 'draft' },
      settings: { type: Schema.Types.Mixed, default: {} },
    },
    { timestamps: true },
  ),
)

export const Page = mongoose.model(
  'Page',
  new Schema(
    {
      site: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
      slug: { type: String, required: true },
      path: { type: String, required: true },
      title: { type: String, default: '' },
      kicker: { type: String, default: '' },
      lede: { type: String, default: '' },
      seoTitle: { type: String, default: '' },
      seoDescription: { type: String, default: '' },
      order: { type: Number, default: 0 },
      sections: { type: [Schema.Types.Mixed], default: [] },
      draft: { type: Schema.Types.Mixed, default: null },
    },
    { timestamps: true },
  ),
)

export const Entry = mongoose.model(
  'Entry',
  new Schema(
    {
      site: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
      collection: { type: String, required: true, index: true },
      slug: { type: String, default: '' },
      title: { type: String, default: '' },
      order: { type: Number, default: 0 },
      published: { type: Boolean, default: true },
      data: { type: Schema.Types.Mixed, default: {} },
    },
    { timestamps: true, suppressReservedKeysWarning: true },
  ),
)

export const Enquiry = mongoose.model(
  'Enquiry',
  new Schema(
    {
      site: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
      email: { type: String, default: '' },
      location: { type: String, default: '' },
      budget: { type: String, default: '' },
      stage: { type: String, default: '' },
      message: { type: String, default: '' },
      source: { type: String, default: 'contact' },
      status: { type: String, default: 'new' },
    },
    { timestamps: true },
  ),
)

export const Checklist = mongoose.model(
  'Checklist',
  new Schema(
    {
      site: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
      location: { type: String, default: '' },
      checklistDate: { type: String, default: '' },
      signature: { type: String, default: '' },
      answers: { type: [Schema.Types.Mixed], default: [] },
      pdfUrl: { type: String, default: '' },
      status: { type: String, default: 'new' },
      submittedAt: { type: String, default: '' },
    },
    { timestamps: true },
  ),
)

export const KnowledgeDoc = mongoose.model(
  'KnowledgeDoc',
  new Schema(
    {
      site: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
      title: { type: String, default: '' },
      filename: { type: String, default: '' },
      mime: { type: String, default: '' },
      storedName: { type: String, default: '' },
      bytes: { type: Number, default: 0 },
      status: { type: String, default: 'processing' },
      error: { type: String, default: '' },
      note: { type: String, default: '' },
      chunkCount: { type: Number, default: 0 },
      uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true },
  ),
)

export const KnowledgeChunk = mongoose.model(
  'KnowledgeChunk',
  new Schema(
    {
      site: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
      document: { type: Schema.Types.ObjectId, ref: 'KnowledgeDoc', required: true, index: true },
      title: { type: String, default: '' },
      page: { type: String, default: '' },
      text: { type: String, default: '' },
      embedding: { type: [Number], default: [] },
    },
    { timestamps: true },
  ),
)

export const ChatThread = mongoose.model(
  'ChatThread',
  new Schema(
    {
      site: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
      user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      title: { type: String, default: 'New chat' },
    },
    { timestamps: true },
  ),
)

export const ChatMessage = mongoose.model(
  'ChatMessage',
  new Schema(
    {
      thread: { type: Schema.Types.ObjectId, ref: 'ChatThread', required: true, index: true },
      role: { type: String, default: 'user' },
      content: { type: String, default: '' },
      sources: { type: [Schema.Types.Mixed], default: [] },
    },
    { timestamps: true },
  ),
)

export const Media = mongoose.model(
  'Media',
  new Schema(
    {
      site: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
      url: { type: String, required: true },
      publicId: { type: String, default: '' },
      resourceType: { type: String, default: 'image' },
      alt: { type: String, default: '' },
      width: { type: Number, default: 0 },
      height: { type: Number, default: 0 },
      bytes: { type: Number, default: 0 },
      folder: { type: String, default: '' },
    },
    { timestamps: true },
  ),
)
