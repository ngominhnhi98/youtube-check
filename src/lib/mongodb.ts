import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

/**
 * In a serverless environment (Vercel) every invocation may run in a fresh
 * module scope, but the underlying container is often reused. We cache the
 * connection on `globalThis` so repeated invocations reuse the same pool
 * instead of opening a new connection every time (which quickly exhausts the
 * MongoDB Atlas free-tier connection limit).
 */
type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

const globalForMongoose = globalThis as unknown as {
  _mongooseCache?: MongooseCache;
};

const cache: MongooseCache =
  globalForMongoose._mongooseCache ?? { conn: null, promise: null };

globalForMongoose._mongooseCache = cache;

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (!MONGODB_URI) {
    throw new Error(
      "MONGODB_URI is not set. Add it to your environment (.env.local / Vercel project settings)."
    );
  }

  if (cache.conn) {
    return cache.conn;
  }

  if (!cache.promise) {
    cache.promise = mongoose.connect(MONGODB_URI, {
      // Fail fast instead of hanging the whole serverless invocation.
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 5,
    });
  }

  try {
    cache.conn = await cache.promise;
  } catch (err) {
    cache.promise = null;
    throw err;
  }

  return cache.conn;
}
