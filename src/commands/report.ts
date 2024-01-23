import moment from "moment-timezone";
import { Op } from "sequelize";
import {
  CommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  Colors,
} from "discord.js";
import puppeteerCore from "puppeteer-core";
import { executablePath } from "puppeteer";
import nodeHtmlToImage from "node-html-to-image";

import Attendance from "@/models/attendance";
import Member from "@/models/member";

type AttendanceRecord = {
  name: string;
  totalHours: number;
  attendance: {
    [date: string]: {
      in?: Date;
      out?: Date;
      totalHours: number;
    };
  };
};

export const data = new SlashCommandBuilder()
  .setName("report")
  .setDescription("Displays members' attendance records.")
  .addStringOption((option) =>
    option
      .setName("startdate")
      .setDescription("Start date for the attendance report.")
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("enddate")
      .setDescription("End date for the attendance report.")
      .setRequired(true)
  )
  .addRoleOption((option) =>
  option
    .setName("role")
    .setDescription("Filter by role.")
    .setRequired(false)
)

export async function execute(interaction: CommandInteraction) {

  const rolePermissionAdmin = interaction.guild?.roles.cache.find((role) => role.name === "Manager" || role.name === "CTO");
  const rolePermission = rolePermissionAdmin ? interaction.guild?.members.cache.get(interaction.user.id)?.roles.cache.has(rolePermissionAdmin?.id || "") : false; // prettier-ignore

  if (!rolePermission) {
    return interaction.reply({
      content: "You don't have permission to use this command.",  
      ephemeral: true,
    });
  }

  if (!interaction.guild) {
    return interaction.reply({
      content: "This command must be used in a guild.",
      ephemeral: true,
    });
  }

  try {
    validateOptions(interaction.options);
  } catch (error) {
    if (error instanceof DateOptionsError) {
      return interaction.reply({
        content: error.message,
        options: {
          ephemeral: true,
        },
      });
    }

    return interaction.reply({
      content: "There was an error while executing this command.",
      options: {
        ephemeral: true,
      },
    });
  }

  await interaction.deferReply();

  const guildMembers = interaction.guild.members.cache.filter((member) => !member.user.bot); // prettier-ignore
  const roleOption = interaction.options.get("role")?.value as string | undefined;
  const filteredMemberIds = roleOption ? guildMembers.filter((member) => member.roles.cache.has(roleOption)).map((member) => member.id) : guildMembers.map((member) => member.id); // prettier-ignore

  const startDateOption = interaction.options.get("startdate")?.value as string;
  const startDate = moment(startDateOption, "MM/DD/YY").startOf("day").toDate();

  const endDateOption = interaction.options.get("enddate")?.value as string;
  const endDate = moment(endDateOption, "MM/DD/YY").endOf("day").toDate();

  const promises = filteredMemberIds.map<Promise<AttendanceRecord>>(
    async (memberId) => {
      const attendances = await Attendance.findAll({
        where: {
          date: {
            [Op.between]: [startDate, endDate],
          },
        },
        order: [["date", "ASC"]],
        include: [
          {
            required: false,
            association: Attendance.associations.member,
            where: {
              discordId: memberId,
            },
          },
          {
            required: false,
            association: Attendance.associations.guild,
            where: {
              discordId: interaction.guild!.id,
            },
          },
        ],
      });

      let totalHours = 0;
      const attendance: AttendanceRecord["attendance"] = {};

      attendances.forEach((record) => {
        const date = moment(record.date).format("MM/DD/YY");

        if (!attendance[date]) {
          attendance[date] = {
            in: record.date,
            out: record.date,
            totalHours: 0,
          };
        }

        if (record.type === "IN") {
          attendance[date].in = record.date;
        }

        if (record.type === "OUT") {
          attendance[date].out = record.date;
        }

        const inMoment = moment(attendance[date].in);
        const outMoment = moment(attendance[date].out);
        const diffHours = Math.round(outMoment.diff(inMoment, "hours", true));

        attendance[date].totalHours = diffHours;
        totalHours += attendance[date].totalHours;
      });

      const member = interaction.guild!.members.cache.get(memberId);
      
      return {
        name: member?.displayName || "N/A",
        attendance,
        totalHours,
      };
    }
  );

  const results = (await Promise.all(promises)).flat();

  const html = generateHTML(results);
  const buffer = (await nodeHtmlToImage({
    html,
    selector: "#report",
    puppeteer: puppeteerCore,
    waitUntil: "networkidle0",
    puppeteerArgs: {
      executablePath: executablePath(),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  })) as Buffer;

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setDescription(
          `Attendance report from ${startDateOption} to ${endDateOption}.`
        )
        .setImage("attachment://report.png")
        .setTimestamp(),
    ],
    files: [
      {
        attachment: buffer,
        name: "report.png",
      },
    ],
  });
}

function generateHTML(records: AttendanceRecord[]): string {
  const createAttendanceCell = (
    attendance: AttendanceRecord["attendance"][0]
  ) => {
    const inSymbol = attendance.in ? "✅" : "❌";
    const outSymbol = attendance.out ? "✅" : "❌";
    return `
      <td class="emoji">${inSymbol}</td>
      <td class="emoji">${outSymbol}</td>
      <td>${attendance.totalHours}</td>
    `;
  };

  const uniqueDates = Array.from(
    new Set(records.flatMap((record) => Object.keys(record.attendance)))
  ).sort();

  let headerRow1 = '<tr><th rowspan="2">Name</th><th rowspan="2">Days</th>';
  let headerRow2 = "<tr>";

  uniqueDates.forEach((date) => {
    headerRow1 += `<th colspan="3">${date}</th>`;
    headerRow2 += "<th>In</th><th>Out</th><th>Hrs</th>";
  });

  headerRow1 += "</tr>";
  headerRow2 += "</tr>";

  let bodyRows = "";
  records.forEach((record) => {
    const workedDays = Object.keys(record.attendance).filter((key) => {
      const attendance = record.attendance[key];
      return attendance.in && attendance.out;
    });

    bodyRows += `
      <tr>
        <th>${record.name}</th>
        <td>${workedDays.length}</td>`;

    uniqueDates.forEach((date) => {
      bodyRows += record.attendance[date]
        ? createAttendanceCell(record.attendance[date])
        : '<td colspan="3">-</td>';
    });

    bodyRows += "</tr>";
  });

  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Attendance Record</title>

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=swap" rel="stylesheet">

    <style>
      table { font-family: "Courier New", Courier, monospace; }
      table, th, td { border: solid 1px; border-collapse: collapse; table-layout: fixed; }
      td, th { text-align: center; padding: 4px 8px; }
      tbody th:first-child { text-align: left; }

      .emoji {
        font-family: 'Noto Color Emoji', sans-serif;
      }
    </style>
  </head>
  <body>
    <table id="report">
      <thead>
        ${headerRow1}
        ${headerRow2}
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>
  </body>
</html>`;
}

class DateOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateOptionsError";
  }
}

function validateOptions(options: CommandInteraction["options"]) {
  const startDate = options.get("startdate")?.value;
  const endDate = options.get("enddate")?.value;

  if (typeof startDate !== "string" || typeof endDate !== "string") {
    throw new DateOptionsError("Start and end date are required.");
  }

  const datePattern = /^\d{2}\/\d{2}\/\d{2}$/;

  if (!datePattern.test(startDate) || !datePattern.test(endDate)) {
    throw new DateOptionsError(
      "Invalid date format. Please use the format MM/DD/YY."
    );
  }

  const startDateMoment = moment(startDate, "MM/DD/YY", true);
  const endDateMoment = moment(endDate, "MM/DD/YY", true);

  if (!startDateMoment.isValid() || !endDateMoment.isValid()) {
    throw new DateOptionsError("Invalid date. Please use a valid date.");
  }

  if (startDateMoment.isAfter(endDateMoment)) {
    throw new DateOptionsError("Start date cannot be after end date.");
  }
}
