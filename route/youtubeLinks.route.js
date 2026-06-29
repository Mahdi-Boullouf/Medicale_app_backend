import express from "express";
import {
  getYoutubeLinks,
  updateYoutubeLinks,
} from "../controller/youtubeLinks.controller.js";
import { protect, isAdmin } from "../middleware/auth.middleware.js";

const router = express.Router();

// Public: fetch the two "How it works" tutorial links
router.get("/", getYoutubeLinks);

// Admin: update the tutorial links
router.patch("/", protect, isAdmin, updateYoutubeLinks);

export default router;
