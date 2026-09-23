/*
 * src/routes/undo.js — POST /api/undo、POST /api/redo
 * 真正的邏輯在 src/undo.js，這裡只是接上網址。
 */
const express = require('express');
const { route } = require('../errors');
const { undo, redo } = require('../undo');

const router = express.Router();
router.post('/undo', route(() => undo()));
router.post('/redo', route(() => redo()));
module.exports = router;
