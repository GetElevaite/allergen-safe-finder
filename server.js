const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// API routes
app.use("/api/search", require("./lib/routes/search.js"));

// Fallback to index.html for root requests
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
