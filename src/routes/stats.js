/*
 * src/routes/stats.js — GET /api/stats?days=7：作業效率統計（邏輯與欄位說明在 src/stats.js）
 */
const express = require('express');
const { pool } = require('../db');
const { route } = require('../errors');
const { stats } = require('../stats');

const router = express.Router();
router.get('/stats', route((req) => stats(pool, Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 365))));
module.exports = router;
