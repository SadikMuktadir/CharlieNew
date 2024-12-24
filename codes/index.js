import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import xlsx from "xlsx";
import dotenv from "dotenv";
import pLimit from "p-limit";

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

const limit = pLimit(2); // Set a limit for concurrent tasks

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
    // Create Excel workbook and worksheets
    const wb = xlsx.utils.book_new();
    const wsData = [
      [
        "SearchAddress",
        "name1",
        "phone1",
        "email1",
        "fullAddress1",
        "name2",
        "phone2",
        "email2",
        "fullAddress2",
        "price",
        "sqft",
      ],
    ];

    const errorData = [
      ["SearchAddress", "Price", "Square Feet", "Error Message"],
    ];
    const noDetailsWorksheetData = [
      ["Address", "Price", "Square Feet", "Status"], // Adding Status column
    ];

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
              // No details found for this address, log it in noDetailsWorksheetData
              const rowData = [
                data.address,
                data.price,
                data.sqft,
                "No results",
              ];
              noDetailsWorksheetData.push(rowData);
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

            // Prepare rowData for Excel, including price and sqft
            const rowData = [
              data.address,
              firstScrapedData.name,
              firstScrapedData.firstPhoneNumber,
              firstScrapedData.email,
              firstScrapedData.fullAddress,
              secondScrapedData.name,
              secondScrapedData.secondPhoneNumber,
              secondScrapedData.email,
              secondScrapedData.fullAddress,
              data.price,
              data.sqft,
            ];

            // Push rowData to worksheet
            wsData.push(rowData);
            console.log(rowData);

            console.log(
              `Data for address: ${data.address} scraped successfully.`
            );
          } catch (error) {
            // console.error(`Error scraping address: ${data.address}`, error);
            // Log error for network or other issues with address, including price and sqft
            errorData.push([
              data.address,
              data.price,
              data.sqft,
              error.message,
            ]);
          } finally {
            if (browser) {
              await browser.close();
            }
          }
        })
      )
    );

    // Write to Excel file
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, "Scraped Data");

    // Create and append errors sheet, including price and sqft
    const errorSheet = xlsx.utils.aoa_to_sheet(errorData);
    xlsx.utils.book_append_sheet(wb, errorSheet, "Error Data");

    // Create and append no details sheet, including price and sqft
    const noDetailsWorksheet = xlsx.utils.aoa_to_sheet(noDetailsWorksheetData);
    xlsx.utils.book_append_sheet(wb, noDetailsWorksheet, "NoDetailsFound");

    const outputFileName = "scraped_data_with_prices_and_sqft.xlsx";
    xlsx.writeFile(wb, outputFileName);
    console.log(`Excel file created: ${outputFileName}`);
  } catch (error) {
    // console.error("Error during scraping process:", error);
  }
}

run();
