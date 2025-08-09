console.log("search.js is loaded");
import express from 'express';
const router = express.Router();

// Placeholder GET route
router.get('/', (req, res) => {
  res.json({ message: 'Search route is not yet implemented.' });
});

export default router;
