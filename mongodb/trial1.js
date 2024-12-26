import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import dotenv from "dotenv";
import pLimit from "p-limit";
import { MongoClient } from "mongodb";

dotenv.config();

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

const limit = pLimit(5); // Set a limit for concurrent tasks

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

async function insertData(data) {
  const db = client.db("scrapingDB"); // Database name
  const collection = db.collection("scrapedData"); // Collection name
  await collection.insertOne(data); // Insert one document into the collection
  console.log("Data inserted into MongoDB:", data.address);
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

// Combine address, price, and square footage
const combinedData = addressData.map((address, index) => ({
  address,
  price: priceData[index],
  sqft: sqftData[index],
}));

async function run() {
  try {
    // Connect to MongoDB
    await client.connect();
    console.log("Connected to MongoDB!");

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
              console.log(`No details found for address: ${data.address}`);
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

            // Combine all data into an object to insert into MongoDB
            const document = {
              address: data.address,
              price: data.price,
              sqft: data.sqft,
              firstPerson: firstScrapedData,
              secondPerson: secondScrapedData,
            };

            // Insert data into MongoDB
            await insertData(document);
          } catch (error) {
            console.error(`Error scraping address: ${data.address}`, error);
          } finally {
            if (browser) {
              await browser.close();
            }
          }
        })
      )
    );
  } catch (error) {
    console.error("Error during MongoDB connection:", error);
  } finally {
    await client.close(); // Close MongoDB connection
    console.log("MongoDB connection closed.");
  }
}

run();
