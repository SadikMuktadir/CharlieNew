import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import dotenv from "dotenv";
import pLimit from "p-limit";
import { MongoClient } from "mongodb";
import express from "express";

dotenv.config();

// Initialize Puppeteer with stealth plugin
puppeteer.use(StealthPlugin());

const limit = pLimit(2); // Set a limit for concurrent tasks

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
let sheetDataCollection;

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

// Function to insert unsuccessful data into MongoDB
async function insertUnsuccessfulData(data) {
  try {
    await unsuccessfulCollection.insertOne(data);
    console.log("Unsuccessful data inserted into MongoDB");
  } catch (error) {
    // console.error("Error inserting unsuccessful data:", error);
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
    // console.log("Error fetching unsuccessful data:", error);
    res.status(500).send("Error fetching data");
  }
});

// Fetch data from MongoDB
async function fetchSheetData() {
  try {
    const sheetData = await sheetDataCollection.find({}).toArray();

    // Map the data into the required format
    return sheetData.map((item) => ({
      address: item?.FullAddress || null,
      price: item?.Price || null,
      sqft: item?.Sqft || null,
    }));
  } catch (error) {
    // console.error("Error fetching sheetData:", error);
    return [];
  }
}

// Split address function
function splitAddress(address) {
  if (!address || typeof address !== "string") {
    throw new Error("Invalid address provided.");
  }
  const [part1, ...parts] = address.split(",");
  if (!part1 || parts.length === 0) {
    throw new Error("Address format is invalid.");
  }
  const formattedAddress = `${part1.trim().replace(/ /g, "-")}_${parts
    .join(" ")
    .trim()
    .replace(/ /g, "-")}`;
  return formattedAddress;
}

// Fetch data from MongoDB
// Ensure the script is wrapped inside an async function to allow proper control flow
(async () => {
  const combinedData = await fetchSheetData();
  if (combinedData.length === 0) {
    console.log("No data available to scrape.");
    return;
  }

  await run();
})();

// Modify the code in your 'run' function
async function run() {
  try {
    // Connect to MongoDB
    await initDB();

    // Fetch data from MongoDB
    const combinedData = await fetchSheetData();
    if (combinedData.length === 0) {
      console.log("No data available to scrape.");
      return;
    }

    // Scrape data for each address using concurrency
    await Promise.all(
      combinedData.map((data, index) =>
        limit(async () => {
          let browser;
          try {
            const formattedAddress = splitAddress(data.address);
            const targetUrl = `https://www.fastpeoplesearch.com/address/${formattedAddress}`;

            browser = await puppeteer.launch({
              headless: false,
              protocolTimeout: 180000,
              timeout: 180000,
              args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--start-maximized",
              ],
              defaultViewport: null,
            });

            const page = await browser.newPage();
            await page.setDefaultNavigationTimeout(0);
            await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

            const buttonSelector = ".btn.btn-primary.link-to-details";
            const isButtonVisible = await page.waitForSelector(buttonSelector, {
              timeout: 45000,
            });

            if (isButtonVisible) {
              await page.evaluate((buttonSelector) => {
                const button = document.querySelector(buttonSelector);
                if (button) {
                  button.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  });
                }
              }, buttonSelector);

              await Promise.all([
                page.waitForNavigation({ waitUntil: "domcontentloaded" }),
                page.click(buttonSelector),
              ]);
            } else {
              throw new Error("Failed to find 'View Free Details' button.");
            }

            await page.waitForSelector("#full_name_section", {
              timeout: 60000,
            });

            const firstScrapedData = await page.evaluate(() => {
              const name =
                document
                  .querySelector("#full_name_section .fullname")
                  ?.textContent?.trim() || null;
              const firstPhoneNumber =
                document
                  .querySelector("#phone_number_section dl dt a")
                  ?.textContent?.trim() || null;
              let email = null;
              document
                .querySelectorAll("#email_section .detail-box-email h3")
                .forEach((emailElement) => {
                  const emailText = emailElement.textContent.trim();
                  if (
                    /@gmail\.com|@yahoo\.com|@hotmail\.com|@aol\.com|@msn\.com|@outlook\.com/.test(
                      emailText
                    )
                  ) {
                    email = emailText;
                  }
                });
              const fullAddress =
                document
                  .querySelector("a[title^='Search people living at']")
                  ?.textContent?.trim() || null;
              return { name, firstPhoneNumber, email, fullAddress };
            });

            if (!firstScrapedData.name) {
              // console.log(`No details found for address: ${data.address}`);
              return; // Skip if no data found for first set
            }

            await page.goBack({ waitUntil: "domcontentloaded" });

            await page.waitForSelector(
              "#site-content .break-word a:nth-of-type(2)"
            );
            const linkToClick = await page.$eval(
              "#site-content .break-word a:nth-of-type(2)",
              (link) => link.href
            );
            await page.goto(linkToClick, { waitUntil: "domcontentloaded" });

            const secondScrapedData = await page.evaluate(() => {
              const name =
                document
                  .querySelector("#full_name_section .fullname")
                  ?.textContent?.trim() || null;
              const secondPhoneNumber =
                document
                  .querySelector("#phone_number_section dl dt a")
                  ?.textContent?.trim() || null;
              let email = null;
              document
                .querySelectorAll("#email_section .detail-box-email h3")
                .forEach((emailElement) => {
                  const emailText = emailElement.textContent.trim();
                  if (
                    /@gmail\.com|@yahoo\.com|@hotmail\.com|@aol\.com|@msn\.com|@outlook\.com/.test(
                      emailText
                    )
                  ) {
                    email = emailText;
                  }
                });
              const fullAddress =
                document
                  .querySelector("a[title^='Search people living at']")
                  ?.textContent?.trim() || null;
              return { name, secondPhoneNumber, email, fullAddress };
            });

            // Prepare the data in the desired structure
            const document = {
              SearchAddress: data.address,
              name1: firstScrapedData.name,
              phone1: firstScrapedData.firstPhoneNumber,
              email1: firstScrapedData.email,
              fullAddress1: firstScrapedData.fullAddress,
              name2: secondScrapedData.name,
              phone2: secondScrapedData.secondPhoneNumber,
              email2: secondScrapedData.email,
              fullAddress2: secondScrapedData.fullAddress,
              squareFeet: data.sqft,
              price: data.price,
            };
            console.log(document);

            // Insert the data into MongoDB
            await insertSuccessfulData(document);
          } catch (error) {
            // console.error(`Error scraping address: ${data.address}`, error);
            // Save unsuccessful data
            const unsuccessfulDocument = {
              SearchAddress: data.address,
              price: data.price,
              squareFeet: data.sqft,
            };
            await insertUnsuccessfulData(unsuccessfulDocument);
          } finally {
            if (browser) {
              await browser.close();
            }
          }
        })
      )
    );
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