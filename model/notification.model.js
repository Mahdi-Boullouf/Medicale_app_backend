// model/notification.model.js
import mongoose, { Schema } from "mongoose";

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true }, // receiver
    fromUserId: { type: Schema.Types.ObjectId, ref: "User" }, // sender (optional)

    type: {
      type: String,
      enum: {
        values: [
          "doctor_signup",
          "doctor_approved",
          "appointment_booked",
          "appointment_confirmed",
          "appointment_cancelled",
          "appointment_completed",
          "appointment_rescheduled",
          "appointment_status_change",
          "appointment_reminder",
          "post_liked",
          "post_commented",
          "reel_liked",
          "reel_commented",
          "new_message",
          "incoming_call",
        ],
        message:
          "Invalid notification type. Allowed values: doctor_signup, doctor_approved, appointment_booked, appointment_confirmed, appointment_cancelled, appointment_completed, appointment_rescheduled, appointment_status_change, appointment_reminder, post_liked, post_commented, reel_liked, reel_commented, new_message, incoming_call",
      },
      required: [true, "Notification type is required"],
    },

    title: { type: String, required: true },
    content: { type: String, required: true },

    appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment" },

    meta: { type: Schema.Types.Mixed },

    isRead: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const Notification = mongoose.model("Notification", notificationSchema);
