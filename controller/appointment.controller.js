// ===controller/appointment.controller.js
import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import {
  deleteFromCloudinary,
  uploadOnCloudinary,
} from "../utils/commonMethod.js";
import { User } from "../model/user.model.js";
import { Appointment } from "../model/appointment.model.js";

import { createNotification } from "../utils/notify.js";
import { io } from "../server.js";

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/; // HH:MM

const normalizeAppointmentType = (t) => {
  const v = String(t || "")
    .toLowerCase()
    .trim();
  if (["physical", "physical_visit", "clinic"].includes(v)) return "physical";
  if (["video", "video_call", "online"].includes(v)) return "video";
  return null;
};

const parseDate = (d) => {
  if (!d) return null;
  const dt = new Date(d); // expect "yyyy-mm-dd"
  return Number.isNaN(dt.getTime()) ? null : dt;
};

const parseJSONMaybe = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

// controller/appointment.controller.js - createAppointment function
// Replace the bookedFor section with this:

export const confirmAppointment = catchAsync(async (req, res) => {
  const { appointmentId } = req.params;
  const { status } = req.body;

  if (!appointmentId || !status) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Appointment ID and status are required",
    );
  }

  // Find the appointment
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment not found");
  }

  // Update appointment status
  const updatedAppointment = await Appointment.findByIdAndUpdate(
    appointmentId,
    { status },
    { new: true },
  );

  if (!updatedAppointment) {
    throw new AppError(
      httpStatus.INTERNAL_ERROR,
      "Failed to update appointment status",
    );
  }

  // Get patient and doctor info for notification
  const patient = await User.findById(appointment.patient);
  const doctor = await User.findById(appointment.doctor);

  // Send notification to patient
  if (patient && status === "accepted") {
    const notificationPayload = {
      userId: patient._id,
      fromUserId: doctor._id,
      type: "appointment_confirmed",
      title: "Appointment Confirmed! 🎉",
      content: `Your appointment with Dr. ${doctor?.fullName || "Doctor"} has been confirmed for ${appointment.appointmentDate} at ${appointment.time}.`,
      appointmentId: appointment._id,
      meta: {
        appointmentType: appointment.appointmentType,
        date: appointment.appointmentDate,
        time: appointment.time,
        patientId: patient._id,
        doctorId: doctor._id,
      },
    };
    await createNotification(notificationPayload);
    // Emit socket event
    io.to(patient._id.toString()).emit(
      "appointment_confirmed",
      notificationPayload,
    );
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment status updated successfully",
    data: updatedAppointment,
  });
});

export const createAppointment = catchAsync(async (req, res) => {
  const {
    doctorId,
    appointmentType, // "physical" | "videooo"
    date, // "2025-12-04"
    time, // "10:30"
    symptoms,
    bookedFor,
  } = req.body;

  const patientId = req.user?._id;

  // 1) validate doctor & patient
  const doctor = await User.findById(doctorId);
  if (!doctor || doctor.role !== "doctor") {
    throw new AppError(httpStatus.NOT_FOUND, "Doctor not found");
  }

  const patient = await User.findById(patientId);
  if (!patient) {
    throw new AppError(httpStatus.NOT_FOUND, "Patient not found");
  }

  const bookedForInput = parseJSONMaybe(bookedFor) || {};
  const typeRaw = String(bookedForInput?.type || "")
    .trim()
    .toLowerCase();

  let bookingScope = "self";

  if (!typeRaw) {
    bookingScope = "self";
  } else if (["self", "me", "myself"].includes(typeRaw)) {
    bookingScope = "self";
  } else if (["dependent", "dependant", "child"].includes(typeRaw)) {
    bookingScope = "dependent";
  } else {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "bookedFor.type must be 'self' or 'dependent'",
    );
  }

  const patientNameSnapshot = String(patient.fullName || "").trim();
  let bookedForPayload =
    bookingScope === "self"
      ? { type: "self", nameSnapshot: patientNameSnapshot }
      : null;

  if (bookingScope === "dependent") {
    const dependentId =
      bookedForInput?.dependentId || bookedForInput?._id || bookedForInput?.id;

    if (!dependentId || !mongoose.Types.ObjectId.isValid(dependentId)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "A valid dependentId is required when booking for a dependent",
      );
    }

    const dependent =
      (patient.dependents || []).find(
        (dep) => String(dep._id) === String(dependentId),
      ) || null;

    if (!dependent) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Dependent not found for the current user",
      );
    }

    if (dependent.isActive === false) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Dependent is inactive and cannot be used for booking",
      );
    }

    bookedForPayload = {
      type: "dependent",
      dependentId: dependent._id,
      nameSnapshot: String(dependent.fullName || "").trim(),
    };
  }

  // 2) validate type
  const type = normalizeAppointmentType(appointmentType);
  if (!type) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "appointmentType must be physical or video",
    );
  }

  // 3) validate date
  const appointmentDate = parseDate(date);
  if (!appointmentDate) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid date format");
  }

  // 4) validate time
  if (!timeRegex.test(time || "")) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "time must be HH:MM in 24-hour format (e.g. 10:30)",
    );
  }

  // 5) upload files
  const medicalDocsFiles = req.files?.medicalDocuments || [];
  const paymentFiles = req.files?.paymentScreenshot || [];

  const medicalDocuments = [];
  for (const file of medicalDocsFiles) {
    const up = await uploadOnCloudinary(file.buffer, {
      folder: "docmobi/appointments/medicalDocs",
      resource_type: "image",
    });
    medicalDocuments.push({ public_id: up.public_id, url: up.secure_url });
  }

  let paymentScreenshot = undefined;
  if (paymentFiles[0]) {
    const up = await uploadOnCloudinary(paymentFiles[0].buffer, {
      folder: "docmobi/appointments/payment",
      resource_type: "image",
    });
    paymentScreenshot = { public_id: up.public_id, url: up.secure_url };
  }

  if (type === "video" && !paymentScreenshot) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Payment screenshot is required for video appointments",
    );
  }

  // 6) conflict check: same doctor, date & time
  const conflict = await Appointment.findOne({
    doctor: doctorId,
    appointmentDate,
    time,
    status: { $in: ["pending", "accepted"] },
  });

  if (conflict) {
    throw new AppError(
      httpStatus.CONFLICT,
      "This time slot is already booked for this doctor",
    );
  }

  // 7) create appointment with proper bookedFor
  const appointment = await Appointment.create({
    doctor: doctorId,
    patient: patientId,
    bookedFor: bookedForPayload, // ✅ Now includes relationship
    appointmentType: type,
    appointmentDate,
    time,
    symptoms,
    medicalDocuments,
    paymentScreenshot,
  });

  // 🔔 Notification – patient booked appointment → notify doctor
  const notificationPayload = {
    userId: doctor._id,
    fromUserId: patient._id,
    type: "appointment_booked",
    title: "New appointment request",
    content: `${patient.fullName} requested an appointment on ${date} at ${time}.`,
    appointmentId: appointment._id,
    meta: {
      appointmentType: type,
      date,
      time,
      patientId,
      patientName: patient.fullName,
      bookedFor: bookedForPayload,
    },
  };

  await createNotification(notificationPayload);
  // Emit socket event
  io.to(doctor._id.toString()).emit("appointment_booked", notificationPayload);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Appointment request submitted",
    data: appointment,
  });
});
export const getAvailableAppointments = catchAsync(async (req, res) => {
  const { doctorId, date } = req.body;

  if (!doctorId || !date) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "doctorId and date are required",
    );
  }

  const doctor = await User.findById(doctorId).select("role weeklySchedule appointmentsDisabled vacations");
  if (!doctor || doctor.role !== "doctor") {
    throw new AppError(httpStatus.NOT_FOUND, "Doctor not found");
  }

  const dateObj = new Date(date);
  if (Number.isNaN(dateObj.getTime())) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid date format");
  }

  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const dayName = dayNames[dateObj.getDay()];

  if (doctor.appointmentsDisabled === true) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Appointments are disabled for this doctor",
      data: {
        date,
        day: dayName,
        slots: [],
      },
    });
  }

  // ✅ NEW: Vacation Check
  const isOnVacation = (doctor.vacations || []).some((v) => {
    const start = new Date(v.startDate);
    const end = new Date(v.endDate);
    // Set end to end of day to be inclusive
    end.setHours(23, 59, 59, 999);
    start.setHours(0, 0, 0, 0);
    return dateObj >= start && dateObj <= end;
  });

  if (isOnVacation) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Doctor is on vacation during this period",
      data: {
        date,
        day: dayName,
        slots: [],
      },
    });
  }

  const weeklySchedule = doctor.weeklySchedule || [];
  const daySchedule = weeklySchedule.find(
    (d) => d.day === dayName && d.isActive,
  );

  if (!daySchedule || !daySchedule.slots?.length) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "No schedule for this day",
      data: {
        date,
        day: dayName,
        slots: [],
      },
    });
  }

  const startOfDay = new Date(dateObj);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const existingAppointments = await Appointment.find({
    doctor: doctorId,
    appointmentDate: { $gte: startOfDay, $lt: endOfDay },
    status: { $in: ["pending", "accepted"] },
  }).select("time");

  const bookedTimesSet = new Set(existingAppointments.map((a) => a.time));

  const allSlots = (daySchedule.slots || []).map((slot) => ({
    start: slot.start,
    end: slot.end,
    isBooked: bookedTimesSet.has(slot.start),
  }));

  const availableSlots = allSlots.filter((s) => !s.isBooked);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Available appointment slots fetched",
    data: {
      date,
      day: dayName,
      slots: availableSlots,
    },
  });
});

// getMyAppointments function - এটা already ভালো আছে, শুধু একটু clean করুন

export const getMyAppointments = catchAsync(async (req, res) => {
  const userId = req.user._id;
  const role = req.user.role;

  const { status, doctorId, patientId, page, limit, sortBy, search } =
    req.query;

  // 🔹 Sort logic
  let sort = {};
  if (sortBy === "oldestToNewest") {
    sort = { createdAt: 1 };
  } else {
    sort = { createdAt: -1 };
  }

  // 🔹 Pagination
  const currentPage = Math.max(Number(page) || 1, 1);
  const pageLimit = Math.min(Number(limit) || 10, 100);
  const skip = (currentPage - 1) * pageLimit;

  // 🔹 Role-based filter
  const matchFilter = {};
  if (role === "patient") matchFilter.patient = userId;
  else if (role === "doctor") matchFilter.doctor = userId;
  else if (role === "admin") {
    if (doctorId) matchFilter.doctor = doctorId;
    if (patientId) matchFilter.patient = patientId;
  } else throw new AppError(httpStatus.FORBIDDEN, "Invalid role");

  // 🔹 Status filter
  if (status && status !== "all") matchFilter.status = status;

  const doctorLookup = [
    {
      $lookup: {
        from: "users",
        localField: "doctor",
        foreignField: "_id",
        as: "doctor",
      },
    },
    { $unwind: "$doctor" },
    {
      $lookup: {
        from: "users",
        localField: "patient",
        foreignField: "_id",
        as: "patient",
      },
    },
    { $unwind: "$patient" },
  ];

  const pipeline = [{ $match: matchFilter }];
  let total;

  if (search) {
    // Search needs the joined names, so we must $lookup before filtering.
    const regex = new RegExp(search, "i");
    pipeline.push(...doctorLookup, {
      $match: {
        $or: [
          { "doctor.fullName": regex },
          { "patient.fullName": regex },
          { "bookedFor.dependentName": regex },
        ],
      },
    });

    const countResult = await Appointment.aggregate([...pipeline, { $count: "total" }]);
    total = countResult[0]?.total || 0;

    pipeline.push({ $sort: { ...sort, appointmentDate: 1, time: 1 } });
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: pageLimit });
  } else {
    // No search: count straight off the (indexed) match, then paginate FIRST
    // and only $lookup the page's rows instead of joining the whole match set.
    total = await Appointment.countDocuments(matchFilter);

    pipeline.push({ $sort: { ...sort, appointmentDate: 1, time: 1 } });
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: pageLimit });
    pipeline.push(...doctorLookup);
  }

  // 🔹 Project fields
  pipeline.push({
    $project: {
      doctor: { _id: 1, fullName: 1, role: 1, specialty: 1, avatar: 1, fees: 1 },
      patient: { _id: 1, fullName: 1, role: 1, avatar: 1, dependents: 1 },
      appointmentDate: 1,
      time: 1,
      status: 1,
      bookedFor: 1,
      appointmentType: 1,
      createdAt: 1,
      symptoms: 1,
      medicalDocuments: 1,
      paymentScreenshot: 1,
      notes: 1,
      reason: 1,
    },
  });

  // 🔹 Fetch paginated appointments
  let appointments = await Appointment.aggregate(pipeline);

  // 🔹 Enrich dependents info if not already
  appointments = appointments.map((appt) => {
    if (appt.bookedFor?.relationship) return appt;

    if (appt.bookedFor?.type === "dependent" && appt.bookedFor?.dependentId) {
      const patient = appt.patient;

      if (patient?.dependents && Array.isArray(patient.dependents)) {
        const dependent = patient.dependents.find(
          (dep) => String(dep._id) === String(appt.bookedFor.dependentId),
        );

        if (dependent) {
          appt.bookedFor.dependentName = dependent.fullName;
          appt.bookedFor.relationship = dependent.relationship;
        }
      }
    }

    return appt;
  });

  // 🔹 Pagination meta
  const totalPages = Math.ceil(total / pageLimit);
  const from = total === 0 ? 0 : skip + 1;
  const to = Math.min(skip + appointments.length, total);
  const hasNext = currentPage < totalPages;
  const hasPrev = currentPage > 1;

  // 🔹 Send response
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointments fetched successfully",
    data: appointments,
    pagination: {
      page: currentPage,
      limit: pageLimit,
      total,
      totalPages,
      from,
      to,
      hasNext,
      hasPrev,
    },
  });
});



export const updateAppointment = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { appointmentType, date, time, symptoms, bookedFor } = req.body;

  const userId = req.user._id;
  const role = req.user.role;

  const appointment = await Appointment.findById(id);
  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment not found");
  }

  const isPatientOwner =
    role === "patient" && String(appointment.patient) === String(userId);
  const isDoctorOwner =
    role === "doctor" && String(appointment.doctor) === String(userId);
  const isAdmin = role === "admin";

  if (!isPatientOwner && !isDoctorOwner && !isAdmin) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "You are not allowed to update this appointment",
    );
  }

  if (["completed", "cancelled"].includes(appointment.status)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Completed or cancelled appointments cannot be updated",
    );
  }

  const updates = {};

  if (appointmentType !== undefined) {
    const type = normalizeAppointmentType(appointmentType);
    if (!type) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "appointmentType must be physical or video",
      );
    }
    updates.appointmentType = type;
  }

  if (date !== undefined) {
    const appointmentDate = parseDate(date);
    if (!appointmentDate) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid date format");
    }
    updates.appointmentDate = appointmentDate;
  }

  if (time !== undefined) {
    if (!timeRegex.test(time || "")) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "time must be HH:MM in 24-hour format (e.g. 10:30)",
      );
    }
    updates.time = time;
  }

  if (symptoms !== undefined) {
    updates.symptoms = String(symptoms);
  }

  if (bookedFor !== undefined) {
    if (!isPatientOwner) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "Only the patient can update bookedFor details",
      );
    }
    updates.bookedFor = buildBookedForPayload(bookedFor, req.user);
  }

  const medicalDocsFiles = req.files?.medicalDocuments || [];
  const paymentFiles = req.files?.paymentScreenshot || [];

  if (medicalDocsFiles.length > 0) {
    for (const doc of appointment.medicalDocuments || []) {
      if (doc?.public_id) {
        await deleteFromCloudinary(doc.public_id).catch(() => { });
      }
    }

    const medicalDocuments = [];
    for (const file of medicalDocsFiles) {
      const up = await uploadOnCloudinary(file.buffer, {
        folder: "docmobi/appointments/medicalDocs",
        resource_type: "image",
      });
      medicalDocuments.push({ public_id: up.public_id, url: up.secure_url });
    }
    updates.medicalDocuments = medicalDocuments;
  }

  if (paymentFiles[0]) {
    if (appointment.paymentScreenshot?.public_id) {
      await deleteFromCloudinary(appointment.paymentScreenshot.public_id).catch(
        () => { },
      );
    }

    const up = await uploadOnCloudinary(paymentFiles[0].buffer, {
      folder: "docmobi/appointments/payment",
      resource_type: "image",
    });
    updates.paymentScreenshot = { public_id: up.public_id, url: up.secure_url };
  }

  const finalType = updates.appointmentType || appointment.appointmentType;
  const finalDate = updates.appointmentDate || appointment.appointmentDate;
  const finalTime = updates.time || appointment.time;

  if (
    finalType === "video" &&
    !updates.paymentScreenshot &&
    !appointment.paymentScreenshot?.url
  ) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Payment screenshot is required for video appointments",
    );
  }

  const scheduleChanged =
    (updates.appointmentDate &&
      new Date(updates.appointmentDate).getTime() !==
      new Date(appointment.appointmentDate).getTime()) ||
    (updates.time && updates.time !== appointment.time);

  // Capture the previous schedule before applying updates (used for the
  // "appointment rescheduled" notification message).
  const previousSchedule = {
    date: appointment.appointmentDate,
    time: appointment.time,
  };

  if (scheduleChanged) {
    const conflict = await Appointment.findOne({
      doctor: appointment.doctor,
      appointmentDate: finalDate,
      time: finalTime,
      status: { $in: ["pending", "accepted"] },
      _id: { $ne: appointment._id },
    });

    if (conflict) {
      throw new AppError(
        httpStatus.CONFLICT,
        "This time slot is already booked for this doctor",
      );
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "No fields to update");
  }

  appointment.set(updates);
  await appointment.save();

  await appointment.populate([
    { path: "doctor", select: "fullName role specialty avatar fees" },
    { path: "patient", select: "fullName role avatar" },
  ]);

  // 🔔 Notify the other party when the appointment is rescheduled (date/time changed)
  if (scheduleChanged) {
    const fmtDate = (d) => {
      try {
        return new Date(d).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      } catch {
        return String(d);
      }
    };

    const doctorId = appointment.doctor?._id;
    const patientId = appointment.patient?._id;
    const doctorName = appointment.doctor?.fullName || "Doctor";
    const patientName = appointment.patient?.fullName || "Patient";

    // Patient rescheduled -> notify doctor; doctor/admin rescheduled -> notify patient
    const notifyPatient = role !== "patient";
    const notifyUserId = notifyPatient ? patientId : doctorId;

    const content = notifyPatient
      ? `Dr. ${doctorName} rescheduled your appointment to ${fmtDate(finalDate)} at ${finalTime}.`
      : `${patientName} rescheduled their appointment to ${fmtDate(finalDate)} at ${finalTime}.`;

    if (notifyUserId) {
      const notificationPayload = {
        userId: notifyUserId,
        fromUserId: userId,
        type: "appointment_rescheduled",
        title: "Appointment Rescheduled",
        content,
        appointmentId: appointment._id,
        meta: {
          newDate: finalDate,
          newTime: finalTime,
          previousDate: previousSchedule.date,
          previousTime: previousSchedule.time,
          doctorId,
          doctorName,
          patientName,
          updatedBy: role,
        },
      };

      await createNotification(notificationPayload);
      // Emit socket event for real-time clients
      io.to(notifyUserId.toString()).emit(
        "appointment_rescheduled",
        notificationPayload,
      );
    }
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment updated successfully",
    data: appointment,
  });
});

//  FIXED: updateAppointmentStatus - Now allows patient to cancel
export const updateAppointmentStatus = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { status, patient, price } = req.body;
  const userId = req.user._id;
  const role = req.user.role;

  const allowedStatuses = ["pending", "accepted", "completed", "cancelled"];

  if (!status || !allowedStatuses.includes(status)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Status must be one of: pending, accepted, completed, cancelled",
    );
  }

  const appointment = await Appointment.findById(id)
    .populate("doctor", "fullName fees role")
    .populate("patient", "fullName role");

  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment not found");
  }

  const isDoctorOwner =
    role === "doctor" && String(appointment.doctor?._id) === String(userId);

  const isPatientOwner =
    role === "patient" && String(appointment.patient?._id) === String(userId);

  const isAdmin = role === "admin";

  // ✅ NEW: Permission logic with patient support
  const canUpdate = isDoctorOwner || isAdmin || isPatientOwner;

  if (!canUpdate) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "You don't have permission to update this appointment",
    );
  }

  // ✅ NEW: Patient can only cancel their own appointments
  if (role === "patient" && status !== "cancelled") {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Patients can only cancel appointments. Other status changes require doctor approval.",
    );
  }

  // ✅ NEW: Check if patient is trying to cancel someone else's appointment
  if (role === "patient" && status === "cancelled") {
    if (String(appointment.patient?._id) !== String(userId)) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "You can only cancel your own appointments",
      );
    }
  }

  const current = appointment.status;
  const transitions = {
    pending: ["accepted", "cancelled"],
    accepted: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
  };

  if (!transitions[current].includes(status) && current !== status) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Invalid status transition from ${current} to ${status}`,
    );
  }

  // ✅ Validation for "completed" status (only doctor/admin)
  if (status === "completed") {
    if (role === "patient") {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "Only doctors can mark appointments as completed",
      );
    }

    if (!patient || !String(patient).trim()) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "patient (fullName) is required when completing appointment",
      );
    }

    const dbPatientName = appointment.patient?.fullName || "";
    if (String(patient).trim() !== dbPatientName) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Patient name does not match appointment patient",
      );
    }

    if (price === undefined || price === null || String(price).trim() === "") {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "price is required when completing appointment",
      );
    }

    const paidAmount = Number(price);
    if (!Number.isFinite(paidAmount) || paidAmount < 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "price must be a valid positive number",
      );
    }

    const doctorFee = Number(appointment.doctor?.fees?.amount || 0);
    if (paidAmount < doctorFee) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Paid amount is less than the doctor's fees",
      );
    }

    // ✅ Set commission: 20 for physical, 40 for video
    appointment.adminEarning = appointment.appointmentType === "video" ? 40 : 20;

    appointment.paymentVerified = true;
    appointment.paidAmount = paidAmount;
  }

  appointment.status = status;
  await appointment.save();

  const patientId = appointment.patient._id;
  const doctorId = appointment.doctor._id;
  const doctorName = appointment.doctor.fullName;
  const patientName = appointment.patient.fullName;

  // ✅ Send notification based on who made the change
  let content = "";
  let notifyUserId = null;
  let fromUserId = userId;

  if (status === "cancelled") {
    if (role === "patient") {
      // Patient cancelled - notify doctor
      content = `${patientName} has cancelled their appointment.`;
      notifyUserId = doctorId;
    } else {
      // Doctor/admin cancelled - notify patient
      content = `Your appointment with ${doctorName} has been cancelled.`;
      notifyUserId = patientId;
    }
  } else if (status === "accepted") {
    content = `${doctorName} has accepted your appointment request.`;
    notifyUserId = patientId;
  } else if (status === "completed") {
    content = `Your appointment with ${doctorName} has been completed.`;
    notifyUserId = patientId;
  }

  if (notifyUserId) {
    // Determine notification type for FCM
    let notificationType = "appointment_status_change";
    let notificationTitle = "Appointment status updated";

    if (status === "accepted") {
      notificationType = "appointment_confirmed";
      notificationTitle = "Appointment Confirmed! 🎉";
    } else if (status === "cancelled") {
      notificationType = "appointment_cancelled";
      notificationTitle = "Appointment Cancelled";
    } else if (status === "completed") {
      notificationType = "appointment_completed";
      notificationTitle = "Appointment Completed";
    }

    const notificationPayload = {
      userId: notifyUserId,
      fromUserId,
      type: notificationType,
      title: notificationTitle,
      content,
      appointmentId: appointment._id,
      meta: {
        status,
        price,
        doctorId,
        doctorName,
        patientName,
        updatedBy: role,
      },
      sendPush: true, // Enable FCM push notification
    };

    await createNotification(notificationPayload);
    // Emit socket event
    io.to(notifyUserId.toString()).emit(notificationType, notificationPayload);
  }

  let sessionInfo = null;

  if (status === "completed") {
    const { amount = 0, currency = "USD" } = appointment.doctor?.fees || {};

    sessionInfo = {
      sessionHolderName: patientName,
      payableAmount: amount,
      currency,
    };
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment status updated",
    data: {
      appointment,
      sessionInfo,
    },
  });
});

export const deleteAppointment = catchAsync(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;
  const role = req.user.role;

  const appointment = await Appointment.findById(id)
    .populate("doctor", "fullName role")
    .populate("patient", "fullName role");
  if (!appointment) {
    throw new AppError(httpStatus.NOT_FOUND, "Appointment not found");
  }

  const isPatientOwner =
    role === "patient" && String(appointment.patient?._id) === String(userId);
  const isDoctorOwner =
    role === "doctor" && String(appointment.doctor?._id) === String(userId);
  const isAdmin = role === "admin";

  if (!isPatientOwner && !isDoctorOwner && !isAdmin) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "You are not allowed to delete this appointment",
    );
  }

  if (appointment.status === "completed" && !isAdmin) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Completed appointments cannot be deleted",
    );
  }

  // Capture parties before deletion so we can notify them afterwards.
  const doctorId = appointment.doctor?._id;
  const patientId = appointment.patient?._id;
  const doctorName = appointment.doctor?.fullName || "Doctor";
  const patientName = appointment.patient?.fullName || "Patient";

  for (const doc of appointment.medicalDocuments || []) {
    if (doc?.public_id) {
      await deleteFromCloudinary(doc.public_id).catch(() => { });
    }
  }

  if (appointment.paymentScreenshot?.public_id) {
    await deleteFromCloudinary(appointment.paymentScreenshot.public_id).catch(
      () => { },
    );
  }

  await appointment.deleteOne();

  // 🔔 Notify the affected party(ies) that the appointment was removed.
  // A removal is effectively a cancellation from the recipient's perspective.
  const notifyTargets = [];
  if (isPatientOwner) {
    notifyTargets.push({ userId: doctorId, content: `${patientName} removed their appointment.` });
  } else if (isDoctorOwner) {
    notifyTargets.push({ userId: patientId, content: `Dr. ${doctorName} removed your appointment.` });
  } else {
    // Admin removed it -> inform both parties
    notifyTargets.push({ userId: patientId, content: `Your appointment with Dr. ${doctorName} has been removed.` });
    notifyTargets.push({ userId: doctorId, content: `Your appointment with ${patientName} has been removed.` });
  }

  for (const target of notifyTargets) {
    if (!target.userId) continue;
    const notificationPayload = {
      userId: target.userId,
      fromUserId: userId,
      type: "appointment_cancelled",
      title: "Appointment Removed",
      content: target.content,
      meta: { doctorId, doctorName, patientName, removedBy: role },
    };
    await createNotification(notificationPayload);
    io.to(target.userId.toString()).emit(
      "appointment_cancelled",
      notificationPayload,
    );
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Appointment deleted successfully",
    data: null,
  });
});

// Admin commission: flat fee earned per completed appointment (in DA).
const ADMIN_FEE_PER_APPOINTMENT = 20;

const getDateRangeForView = (view) => {
  const now = new Date();
  now.setMilliseconds(0);
  const end = now;

  let start;

  if (view === "daily") {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (view === "weekly") {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    start.setDate(start.getDate() - 6);
  } else if (view === "monthly") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (view === "all") {
    // No date range → include all completed appointments (all-time total)
    return { start: null, end: null };
  }

  return { start, end };
};

export const getEarningsOverview = catchAsync(async (req, res) => {
  const role = req.user.role;
  const userId = req.user._id;
  const view = (req.query.view || "monthly").toLowerCase();

  if (!["daily", "weekly", "monthly", "all"].includes(view)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "view must be one of: daily, weekly, monthly, all",
    );
  }

  const { start, end } = getDateRangeForView(view);

  const baseMatch = {
    status: "completed",
  };

  if (start && end) {
    baseMatch.appointmentDate = { $gte: start, $lte: end };
  }

  if (role === "doctor") {
    const match = { ...baseMatch, doctor: userId };

    const appointments = await Appointment.find(match)
      .populate("doctor", "fees")
      .lean();

    let totalEarnings = 0;
    let physicalEarnings = 0;
    let videoEarnings = 0;
    let totalAppointments = appointments.length;
    let physicalCount = 0;
    let videoCount = 0;

    const weeklyByWeekday = [0, 0, 0, 0, 0, 0, 0];

    for (const appt of appointments) {
      // Use actual paid amount if available, otherwise fall back to doctor's current fee
      const paidAmount = Number(appt.paidAmount || 0);
      const doctorFee = Number(appt.doctor?.fees?.amount || 0);
      const fee = paidAmount > 0 ? paidAmount : doctorFee;
      totalEarnings += fee;

      if (appt.appointmentType === "physical") {
        physicalEarnings += fee;
        physicalCount++;
      } else if (appt.appointmentType === "video") {
        videoEarnings += fee;
        videoCount++;
      }

      if (view === "weekly" && appt.appointmentDate) {
        const d = new Date(appt.appointmentDate);
        const idx = d.getDay();
        weeklyByWeekday[idx] += fee;
      }
    }

    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Doctor earnings overview fetched",
      data: {
        scope: "doctor",
        view,
        totalEarnings,
        totalAppointments,
        physical: {
          earnings: physicalEarnings,
          count: physicalCount,
        },
        video: {
          earnings: videoEarnings,
          count: videoCount,
        },
        weeklyByWeekday:
          view === "weekly"
            ? {
              labels: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
              values: weeklyByWeekday,
            }
            : null,
      },
    });
  }

  if (role === "admin") {
    const match = { ...baseMatch };

    const appointments = await Appointment.find(match)
      .populate("doctor", "fullName specialty fees")
      .lean();

    let totalEarning = 0; // Total doctor fees
    let totalAdminEarning = 0; // Total admin commissions
    let physicalAdminEarning = 0;
    let videoAdminEarning = 0;
    let totalAppointments = appointments.length;

    const perDoctor = new Map();

    for (const appt of appointments) {
      const doc = appt.doctor;
      if (!doc) continue;

      const fee = Number(doc.fees?.amount || 0);
      totalEarning += fee;

      // Admin earns a flat 20 DA for every completed appointment.
      const commission = ADMIN_FEE_PER_APPOINTMENT;
      totalAdminEarning += commission;

      if (appt.appointmentType === "video") {
        videoAdminEarning += commission;
      } else {
        physicalAdminEarning += commission;
      }

      const docId = String(doc._id);
      if (!perDoctor.has(docId)) {
        perDoctor.set(docId, {
          doctorId: docId,
          doctorName: doc.fullName || "",
          specialty: doc.specialty || "",
          appointments: 0,
          earnings: 0,
          adminCommission: 0,
        });
      }

      const entry = perDoctor.get(docId);
      entry.appointments += 1;
      entry.earnings += fee;
      entry.adminCommission += commission;
    }

    const doctors = Array.from(perDoctor.values());
    const avgPerDoctor =
      doctors.length > 0 ? totalEarning / doctors.length : 0;

    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Admin earnings overview fetched",
      data: {
        scope: "admin",
        view,
        totalDoctorFees: totalEarning,
        totalAdminEarnings: totalAdminEarning,
        totalAppointments,
        avgPerDoctor,
        physicalAdminEarning,
        videoAdminEarning,
        doctors,
      },
    });
  }

  throw new AppError(
    httpStatus.FORBIDDEN,
    "Only doctor or admin can view earnings overview",
  );
});

/**
 * Admin: earnings for ONE doctor, optionally within a custom date range.
 * GET /appointment/earnings/doctor/:doctorId?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Both dates optional; omit them for all-time. endDate is inclusive (whole day).
 */
export const getDoctorEarnings = catchAsync(async (req, res) => {
  const { doctorId } = req.params;
  const { startDate, endDate } = req.query;

  if (!mongoose.Types.ObjectId.isValid(doctorId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid doctor id");
  }

  const doctor = await User.findOne({ _id: doctorId, role: "doctor" })
    .select("fullName specialty avatar fees email phone")
    .lean();
  if (!doctor) {
    throw new AppError(httpStatus.NOT_FOUND, "Doctor not found");
  }

  const match = { status: "completed", doctor: doctor._id };

  // Optional custom date range on appointmentDate.
  let start = null;
  let end = null;
  if (startDate) {
    start = new Date(startDate);
    if (isNaN(start)) throw new AppError(httpStatus.BAD_REQUEST, "Invalid startDate");
    start.setHours(0, 0, 0, 0);
  }
  if (endDate) {
    end = new Date(endDate);
    if (isNaN(end)) throw new AppError(httpStatus.BAD_REQUEST, "Invalid endDate");
    end.setHours(23, 59, 59, 999);
  }
  if (start || end) {
    match.appointmentDate = {};
    if (start) match.appointmentDate.$gte = start;
    if (end) match.appointmentDate.$lte = end;
  }

  const appointments = await Appointment.find(match)
    .select("appointmentType appointmentDate")
    .lean();

  const fee = Number(doctor.fees?.amount || 0);
  let totalAppointments = appointments.length;
  let physicalCount = 0;
  let videoCount = 0;

  for (const appt of appointments) {
    if (appt.appointmentType === "video") videoCount++;
    else physicalCount++;
  }

  const doctorEarnings = totalAppointments * fee;
  const adminEarnings = totalAppointments * ADMIN_FEE_PER_APPOINTMENT;

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Doctor earnings fetched",
    data: {
      doctor: {
        _id: doctor._id,
        fullName: doctor.fullName,
        specialty: doctor.specialty,
        avatar: doctor.avatar,
        email: doctor.email,
        phone: doctor.phone,
        fee,
      },
      range: {
        startDate: start ? start.toISOString() : null,
        endDate: end ? end.toISOString() : null,
      },
      totalAppointments,
      doctorEarnings,
      adminEarnings,
      physical: { count: physicalCount, earnings: physicalCount * fee },
      video: { count: videoCount, earnings: videoCount * fee },
    },
  });
});
