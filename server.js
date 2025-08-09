import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// ==== API ROUTES ====
// Example — replace with your actual routes
import searchRoutes from "./lib/routes/search.js";
app.use("/api/search", searchRoutes);

// ==== FRONTEND FALLBACK ====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==== START SERVER ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
