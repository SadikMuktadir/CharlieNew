import dotenv from "dotenv";

import { MongoClient } from "mongodb";
import express from "express";

dotenv.config();

// MongoDB connection URI and client setup
const uri =
  "mongodb+srv://scrapedData:271Zj3AArdKaeW75@cluster0.k6zwazt.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri, {
  serverApi: {
    version: "1",
    strict: true,
    deprecationErrors: true,
  },
});

// Express setup
const app = express();
const port = process.env.PORT || 3000;

let successfulCollection;
let unsuccessfulCollection;

// Initialize MongoDB collections
async function initDB() {
  try {
    await client.connect();
    console.log("Connected to MongoDB!");
    const db = client.db("scrapedData");
    successfulCollection = db.collection("addresses");
    unsuccessfulCollection = db.collection("unsuccessfulAddresses");
    sheetDataCollection = db.collection("sheetData");
  } catch (error) {
    // console.error("Error connecting to MongoDB:", error);
  }
}

// Function to insert successful data into MongoDB
async function insertSuccessfulData(data) {
  try {
    await successfulCollection.insertOne(data);
    console.log("Successful data inserted into MongoDB");
  } catch (error) {
    // console.error("Error inserting successful data:", error);
  }
}

// Route to get scraped data from MongoDB
app.get("/get-scraped-data", async (req, res) => {
  try {
    const data = await successfulCollection.find({}).toArray();
    res.json(data);
  } catch (error) {
    // console.log("Error fetching data:", error);
    res.status(500).send("Error fetching data");
  }
});

// Route to get unsuccessful data from MongoDB
app.get("/get-unsuccessful-data", async (req, res) => {
  try {
    const data = await unsuccessfulCollection.find({}).toArray();
    res.json(data);
  } catch (error) {
    console.log("Error fetching unsuccessful data:", error);
    res.status(500).send("Error fetching data");
  }
});
async function run() {
  try {
    // Connect to MongoDB
    await initDB();
  } catch (error) {
    // console.error("Error during MongoDB connection:", error);
  } finally {
    console.log("MongoDB connection completed.");
  }
}
run();

// Start Express server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
