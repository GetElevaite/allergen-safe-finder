import express from "express";
import cors from "cors";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import searchRoute from "./lib/routes/search.js";

config();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Routes
app.use("/api/search", searchRoute);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
