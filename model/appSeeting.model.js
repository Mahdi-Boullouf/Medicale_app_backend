import mongoose from "mongoose";

const appSettingSchema = new mongoose.Schema(
  {
    referralSystemEnabled: {
      type: Boolean,
      default: true,
    },
    // "How it works" tutorial videos shown in the profile section.
    patientVideoUrl: {
      type: String,
      default: "",
      trim: true,
    },
    doctorVideoUrl: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

const AppSetting = mongoose.model("AppSetting", appSettingSchema);
export default AppSetting;
