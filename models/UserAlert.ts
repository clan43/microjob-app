import { Schema, model, models } from "mongoose";

/**
 * A popup message the admin sends to users from Admin -> User Alerts.
 *  - mode "template": a ready-made design (info / success / offer ...) filled from `template`
 *  - mode "html":     the admin pastes a finished HTML design (like the mail campaign)
 * Who has seen / closed it is tracked per user in UserAlertReceipt.
 */
const UserAlertSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    mode: { type: String, enum: ["template", "html"], default: "template" },
    template: {
      kind: {
        type: String,
        enum: ["info", "success", "warning", "danger", "offer", "celebrate", "maintenance"],
        default: "info",
      },
      title: { type: String, default: "", maxlength: 160 },
      message: { type: String, default: "", maxlength: 2000 },
      ctaText: { type: String, default: "", maxlength: 60 },
      ctaUrl: { type: String, default: "", maxlength: 500 },
      closeText: { type: String, default: "", maxlength: 40 },
    },
    html: { type: String, default: "", maxlength: 90000 },
    width: { type: String, enum: ["sm", "md", "lg"], default: "md" },
    audience: { type: String, enum: ["all", "subscribed", "not_subscribed", "specific"], default: "all" },
    targetEmails: { type: [String], default: [] },
    targetUserIds: { type: [Schema.Types.ObjectId], default: [] },
    /** once = until the user closes it; daily = again every new day until it expires / is stopped */
    repeat: { type: String, enum: ["once", "daily"], default: "once" },
    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    active: { type: Boolean, default: true, index: true },
    priority: { type: Number, default: 0 },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);

UserAlertSchema.index({ active: 1, startsAt: 1, expiresAt: 1 });

const UserAlert = models.UserAlert || model("UserAlert", UserAlertSchema);
export default UserAlert;
