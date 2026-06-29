import httpStatus from "http-status";
import AppSetting from "../model/appSeeting.model.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";

/**
 * GET /api/v1/youtube-links
 * Public. Returns the two "How it works" tutorial video links.
 *   - patientVideo: link shown to patients
 *   - doctorVideo:  link shown to doctors
 */
export const getYoutubeLinks = catchAsync(async (req, res) => {
  let settings = await AppSetting.findOne().select(
    "patientVideoUrl doctorVideoUrl _id",
  );

  // Create a default settings document on first access so the field exists.
  if (!settings) {
    settings = await AppSetting.create({});
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "YouTube links fetched successfully",
    data: {
      patientVideo: settings.patientVideoUrl || "",
      doctorVideo: settings.doctorVideoUrl || "",
    },
  });
});

/**
 * PATCH /api/v1/youtube-links
 * Admin only. Updates either/both tutorial links.
 * body: { patientVideo?: string, doctorVideo?: string }
 */
export const updateYoutubeLinks = catchAsync(async (req, res) => {
  const { patientVideo, doctorVideo } = req.body;

  let settings = await AppSetting.findOne();
  if (!settings) settings = await AppSetting.create({});

  if (patientVideo !== undefined) settings.patientVideoUrl = String(patientVideo).trim();
  if (doctorVideo !== undefined) settings.doctorVideoUrl = String(doctorVideo).trim();

  await settings.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "YouTube links updated successfully",
    data: {
      patientVideo: settings.patientVideoUrl || "",
      doctorVideo: settings.doctorVideoUrl || "",
    },
  });
});
