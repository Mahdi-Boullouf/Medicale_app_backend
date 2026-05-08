import "dotenv/config";
import mongoose from "mongoose";
import { User } from "./model/user.model.js";

const migrate = async () => {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_DB_URL);
    console.log("Connected! Starting migration...");

    const result = await User.updateMany(
      { 
        $or: [
          { wilaya: { $exists: false } },
          { commune: { $exists: false } },
          { isVideoCallAvailable: { $exists: false } },
          { isOnlineAppointmentAvailable: { $exists: false } }
        ]
      },
      { 
        $set: { 
          wilaya: "",
          commune: "",
          isVideoCallAvailable: false,
          isOnlineAppointmentAvailable: true,
          fcmToken: null,
          voipToken: null,
          devicePlatform: null,
          devices: []
        } 
      }
    );

    console.log(`✅ Migration complete! Updated ${result.modifiedCount} users.`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
};

migrate();
