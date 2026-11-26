import { Schema, model, models } from "mongoose";

/** One row per (alert, user): has this user seen / closed / clicked the alert. */
const UserAlertReceiptSchema = new Schema(
  {
    alertId: { type: Schema.Types.ObjectId, ref: "UserAlert", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    firstShownAt: { type: Date, default: null },
    shownCount: { type: Number, default: 0, min: 0 },
    lastShownDay: { type: String, default: "" },
    dismissedAt: { type: Date, default: null },
    lastDismissDay: { type: String, default: "" },
    clickedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

UserAlertReceiptSchema.index({ alertId: 1, userId: 1 }, { unique: true });

const UserAlertReceipt = models.UserAlertReceipt || model("UserAlertReceipt", UserAlertReceiptSchema);
export default UserAlertReceipt;
