import express from "express";
import {
  changePassword,
  forgetPassword,
  login,
  logout,
  refreshToken,
  register,
  resetPassword,
  verifyOTP,
  verifyEmail,
  resendEmailVerification,
} from "../controller/auth.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import { rateLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

router.post("/register", register);
router.post("/login", rateLimiter(10), login);
router.post("/forget", rateLimiter(10),forgetPassword);
router.post("/reset-password", rateLimiter(5), resetPassword);
router.post("/change-password", protect, changePassword);
router.post("/refresh-token", refreshToken);
router.post("/logout", protect, logout);
router.post("/verify-otp", rateLimiter(3), verifyOTP);
router.get("/verify-email", verifyEmail);
router.post("/resend-verification", rateLimiter(3), resendEmailVerification);

export default router;