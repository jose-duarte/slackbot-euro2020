const flagsEmoji = require("./flags.json")
const schedule = require("node-schedule");
const moment = require("moment");
const http = require("http");
const _ = require("lodash");
const fs = require("fs");

const showZones = JSON.parse(process.env.SHOW_ZONES_JSON);
const dbFile = "football-data.json";
const dataApiOptions = {
    host: "api.football-data.org",
    port: 80,
    path: "/v2/competitions/EC/matches",
    method: "GET",
    headers: {
        "X-Auth-Token": process.env.FOOTBALL_DATA_API_TOKEN
    }
};

module.exports = function(logger, t, postToSlack) {
    logger.debug("current config: " + JSON.stringify({
        HIGHLIGHTED_TEAM: process.env.HIGHLIGHTED_TEAM,
        SHOW_ZONES_JSON: process.env.SHOW_ZONES_JSON,
        FOOTBALL_DATA_API_TOKEN: "***" + process.env.FOOTBALL_DATA_API_TOKEN.slice(-5)
    }));

    const today = getToday();
    http
    .request(dataApiOptions, res => {
        logger.info("api call made, response: " + res.statusCode);
        logger.log("silly", "api call made, headers: " + JSON.stringify(res.headers));
        res.setEncoding("utf8");
        let body = "";
        res.on("data", chunk => {
            logger.debug("data from api call arrived");
            logger.log("silly", "data from api call arrived, chunk: " + chunk);
            body += chunk;
        });
        res.on("end", () => {
            logger.debug("data from api call completed");
            logger.log("silly", "data from api call arrived, body: " + body);

            const bodyData = JSON.parse(body);
            let apiData = parseApiData(logger, bodyData);

            if (!fs.existsSync(dbFile)) {
                createInitialDb(today, logger, bodyData);
            }
            let dbData = JSON.parse(fs.readFileSync(dbFile));
            _.forEach(apiData, apimatch => {
                let dbmatch = _.findLast(dbData, ["id", apimatch.id]);
                processmatch(logger, t, postToSlack, today, apimatch, dbmatch);
            });

            const dbDataAsString = JSON.stringify(dbData, null, 4);
            logger.log("silly", "data saved to db, dbData: " + dbDataAsString);
            fs.writeFileSync(dbFile, dbDataAsString);
            logger.info("api call process ended");
        });
        res.on("error", error => {
            logger.error(error.message);
        });
    })
    .end();
}

function createInitialDb(today, logger, apiData) {
    logger.info("creating db");
    logger.debug("processing matches: " + apiData.matches.length);
    let dbData = [];
    _.forEach(apiData.matches, data => {
        logger.debug("processing " + data.homeTeamName + data.awayTeamName + data.date);
        let dbDataItem = {};
        dbDataItem.id = getId(data);
        const matchDate = moment(data.date);
        dbDataItem.posted = matchDate.isBefore(today);
        dbDataItem.status = data.status;
        dbDataItem.date = data.date,
        dbDataItem.homeTeamName = data.homeTeamName;
        dbDataItem.awayTeamName = data.awayTeamName;
        dbDataItem.goalsHomeTeam = data.result.goalsHomeTeam;
        dbDataItem.goalsAwayTeam = data.result.goalsAwayTeam;
        dbData.push(dbDataItem);
    });
    const dbDataAsString = JSON.stringify(dbData, null, 4);
    logger.log("silly", dbDataAsString);
    fs.writeFileSync(dbFile, dbDataAsString);
}

function processmatch(logger, t, postToSlack, today, apimatch, dbmatch) {
    logger.log("silly", "processing match: " + apimatch.id);

    const homeTeamDecoration = apimatch.homeTeamName === process.env.HIGHLIGHTED_TEAM ? "*" : "";
    const awayTeamDecoration = apimatch.awayTeamName === process.env.HIGHLIGHTED_TEAM ? "*" : "";

    const matchDate = moment(apimatch.date);

    if (
        today.date() === matchDate.date() &&
        today.month() === matchDate.month() &&
        today.year() === matchDate.year()
    ) {
        if (!dbmatch.posted) {
            const matchHour = getMatchHour(matchDate);
            if (apimatch.goalsHomeTeam === null ||
                apimatch.goalsAwayTeam === null) {
                postToSlack(t("Today's match {home} vs {away} at {date}", {
                    home: homeTeamDecoration + t(apimatch.homeTeamName) + homeTeamDecoration + " " + flagsEmoji[apimatch.homeTeamName],
                    away: flagsEmoji[apimatch.awayTeamName] + " " + awayTeamDecoration + t(apimatch.awayTeamName) + awayTeamDecoration,
                    date: matchHour
                }));
            }
        } else {
            if (apimatch.status !== dbmatch.status) {
                switch(apimatch.status) {
                    case "IN_PLAY":
                        postToSlack(t(":goal_net: {home} vs {away} match started!", {
                            home: homeTeamDecoration + t(apimatch.homeTeamName) + homeTeamDecoration + " " + flagsEmoji[apimatch.homeTeamName],
                            away: flagsEmoji[apimatch.awayTeamName] + " " + awayTeamDecoration + t(apimatch.awayTeamName) + awayTeamDecoration
                        }));
                        break;
                    case "FINISHED":
                        postToSlack(t(":sports_medal: Final results for {home} vs {away}, {home} {homeGoals} - {awayGoals} {away}", {
                            home: homeTeamDecoration + t(apimatch.homeTeamName) + homeTeamDecoration + " " + flagsEmoji[apimatch.homeTeamName],
                            away: flagsEmoji[apimatch.awayTeamName] + " " + awayTeamDecoration + t(apimatch.awayTeamName) + awayTeamDecoration,
                            homeGoals: apimatch.goalsHomeTeam,
                            awayGoals: apimatch.goalsAwayTeam
                        }));
                        break;
                }
            } else {
                if (
                    apimatch.goalsHomeTeam !== dbmatch.goalsHomeTeam ||
                    apimatch.goalsAwayTeam !== dbmatch.goalsAwayTeam
                ) {
                    postToSlack(t("New update for {home} vs {away}, {home} {homeGoals} - {awayGoals} {away}", {
                        home: homeTeamDecoration + t(apimatch.homeTeamName) + homeTeamDecoration + " " + flagsEmoji[apimatch.homeTeamName],
                        away: flagsEmoji[apimatch.awayTeamName] + " " + awayTeamDecoration + t(apimatch.awayTeamName) + awayTeamDecoration,
                        homeGoals: apimatch.goalsHomeTeam,
                        awayGoals: apimatch.goalsAwayTeam
                    }));
                }
            }
        }

        dbmatch.status = apimatch.status;
        dbmatch.goalsHomeTeam = apimatch.goalsHomeTeam;
        dbmatch.goalsAwayTeam = apimatch.goalsAwayTeam;
        dbmatch.posted = true;
    }
}

function getMatchHour(date) {
    let hours = [];
    for (var zone in showZones) {
        if (showZones.hasOwnProperty(zone)) {
            hours.push(date.clone().utc().add(parseInt(showZones[zone]), "hours").format("LT") + " " + zone);
        }
    }
    return hours.join(", ");
}

function parseApiData(logger, bodyData) {
    let apiData = [];
    if (!bodyData || bodyData.error) {
        logger.error(bodyData.error);
        return apiData;
    }
    _.forEach(bodyData.matches, match => {
        apiData.push({
            id: getId(match),
            posted: false,
            status: match.status,
            date: match.date,
            homeTeamName: match.homeTeamName,
            awayTeamName: match.awayTeamName,
            goalsHomeTeam: match.result.goalsHomeTeam,
            goalsAwayTeam: match.result.goalsAwayTeam
        });
    });
    return apiData;
}

function getId(match) {
    // After this date there is only one match per day and we dont know the
    // teams yet, so the id is just the date
    if (moment(match.date).isAfter("2018-06-30T00:00:00Z")) {
        return match.date;
    }
    return match.date + "_" + match.homeTeamName + "_" + match.awayTeamName;
}

function getToday() {
    return moment();
}
