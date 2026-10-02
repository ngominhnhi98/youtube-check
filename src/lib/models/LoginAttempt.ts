import mongoose, { Schema, InferSchemaType, Model } from "mongoose";

/**
 * Failed-login bookkeeping, one document per client IP.
 *
 * Kept in Mongo rather than in memory on purpose: serverless functions are
 * spread over many short-lived instances, so an in-process counter would reset
 * constantly and let an attacker guess forever.
 */
const LoginAttemptSchema = new Schema({
  ip: { type: String, required: true, unique: true },
  failures: { type: Number, default: 0 },
  /** Start of the current counting window. */
  firstFailureAt: { type: Date, default: Date.now },
  lastFailureAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date, default: null },
});

// Forget quiet IPs after a day so the collection stays tiny.
LoginAttemptSchema.index({ lastFailureAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export type LoginAttemptDoc = InferSchemaType<typeof LoginAttemptSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const LoginAttempt: Model<LoginAttemptDoc> =
  (mongoose.models.LoginAttempt as Model<LoginAttemptDoc>) ||
  mongoose.model<LoginAttemptDoc>("LoginAttempt", LoginAttemptSchema);
