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

// Load JSON files
const addressData = JSON.parse(
  fs.readFileSync(new URL("../json/address.json", import.meta.url))
);
const priceData = JSON.parse(
  fs.readFileSync(new URL("../json/price.json", import.meta.url))
);
const sqftData = JSON.parse(
  fs.readFileSync(new URL("../json/sqft.json", import.meta.url))
);

const limit = pLimit(2); // Set a limit for concurrent tasks

// MongoDB connection URI and client setup
const uri =
  "mongodb+srv://charlieScrape:poTeSWQ4yDQ8F0Hb@cluster0.k6zwazt.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
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

// Combine address, price, and square footage
const combinedData = addressData.map((address, index) => ({
  address,
  price: priceData[index],
  sqft: sqftData[index],
}));

// Modify the code in your 'run' function
async function run() {
  try {
    // Connect to MongoDB
    await initDB();

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

            // First scraping step
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
              throw new Error("No details found for address");
            }

            // Second scraping step
            const secondScrapedData = await page.evaluate(() => {
              const name2 =
                document
                  .querySelectorAll("#full_name_section .fullname")
                  ?.textContent?.trim() || null;
              const phone2 =
                document
                  .querySelectorAll("#phone_number_section dl dt a")
                  ?.textContent?.trim() || null;
              let email2 = null;
              document
                .querySelectorAll("#email_section .detail-box-email h3")
                .forEach((emailElement, index) => {
                  if (index === 1) {
                    const emailText = emailElement.textContent.trim();
                    if (
                      /@gmail\.com|@yahoo\.com|@hotmail\.com|@aol\.com|@msn\.com|@outlook\.com/.test(
                        emailText
                      )
                    ) {
                      email2 = emailText;
                    }
                  }
                });
              const fullAddress2 =
                document
                  .querySelectorAll("a[title^='Search people living at']")
                  ?.textContent?.trim() || null;
              return { name2, phone2, email2, fullAddress2 };
            });

            // Save successful data
            const document = {
              SearchAddress: data.address,
              name1: firstScrapedData.name,
              phone1: firstScrapedData.firstPhoneNumber,
              email1: firstScrapedData.email,
              fullAddress1: firstScrapedData.fullAddress,
              name2: secondScrapedData.name2,
              phone2: secondScrapedData.phone2,
              email2: secondScrapedData.email2,
              fullAddress2: secondScrapedData.fullAddress2,
              price: data.price,
              squareFeet: data.sqft,
            };
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
    // console.error("Error during scraping process:", error);
  } finally {
    console.log("Scraping process completed.");
  }
}

run();

// Start Express server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
