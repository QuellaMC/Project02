//! Web Search, an app of the App Store's catalog: its one file installed on
//! her phone as the store installs it, used through the phone's own calls,
//! each search she makes answered as Tavily's pages show its answers.

use p02_phone::{Account, Acting, Ask, Exchange, Fetch, Fetched, Method, Phone, Source};
use serde_json::{Value, json};

use crate::support::{Files, at, input, millis};

/// Web Search as the catalog serves it.
const SEARCH: &str = include_str!("../../catalog/search.js");
/// Wednesday 11 November 2026, 12:41 PM in New York.
const NOON: &str = "2026-11-11T17:41:00.000Z";
/// An hour after it.
const LATER: &str = "2026-11-11T18:41:00.000Z";
/// What she searches for, as the design has her search.
const TEA: &str = "how long to steep green tea";

fn phone() -> &'static Phone {
    Phone::bundled().unwrap()
}

/// Her phone's files, with Web Search installed on it from the catalog.
fn installed() -> Files {
    let mut files = Files::default();

    phone()
        .install(&mut files, SEARCH, Source::Catalog)
        .unwrap();
    files
}

/// Her search for `given` at `moment`, each request it asks for answered in
/// turn from `answers`: the requests it asked for, and what it answered or
/// the sentence it was refused in, none while it asks for a request
/// `answers` does not answer.
fn search(
    files: &mut Files,
    given: &Value,
    answers: &[Result<Fetched, String>],
    moment: &str,
) -> (Vec<Fetch>, Option<Result<Value, String>>) {
    let mut asked = Vec::new();
    let mut exchanges = Vec::new();
    let came = loop {
        match phone().act(
            files,
            "search",
            "search",
            &input(given),
            &exchanges,
            &at(moment),
        ) {
            Ok(Acting::Asks(Ask::Fetch(fetch))) => {
                asked.push(fetch.clone());

                let Some(fetched) = answers.get(exchanges.len()) else {
                    break None;
                };

                exchanges.push(Exchange::Fetch {
                    fetch,
                    fetched: fetched.clone(),
                });
            }
            Ok(Acting::Asks(ask)) => panic!("it asks for {ask:?}"),
            Ok(Acting::Acted(acted)) => break Some(Ok(acted.answer)),
            Err(refused) => break Some(Err(refused.to_string())),
        }
    };

    (asked, came)
}

/// What Web Search shows.
fn look(files: &Files) -> Value {
    serde_json::to_value(phone().look(files, "search", "search", &at(NOON)).unwrap()).unwrap()
}

/// An answer of Tavily's of `status` and `body`.
fn answer(status: u16, body: &str) -> Fetched {
    Fetched {
        status,
        body: body.to_owned(),
    }
}

/// Tavily's answer to a search for `query` that found `results`.
fn found(query: &str, results: &Value) -> Fetched {
    answer(
        200,
        &json!({
            "query": query,
            "results": results,
            "response_time": 1.08,
            "request_id": "8a5c2e41-7d3b-4f6a-9e10-2b4c6d8f0a13",
        })
        .to_string(),
    )
}

/// What Tavily finds for how long to steep green tea: the design's three
/// pages, the first at a host that begins `www.`.
fn tea() -> Value {
    json!([
        {
            "title": "Green tea brewing guide",
            "url": "https://www.teaguide.example/green-tea",
            "content": "Steep green tea for two to three minutes in water at about 80°C. Longer \
                        makes it bitter.",
            "score": 0.913_45,
        },
        {
            "title": "Why green tea turns bitter",
            "url": "https://kitchennotes.example/bitter",
            "content": "Water that is too hot and a long steep draw out tannins.",
            "score": 0.872_11,
        },
        {
            "title": "Steeping times by type",
            "url": "https://brewtimes.example/times?type=all",
            "content": "Green: 2 to 3 minutes. Black: 3 to 5 minutes. Herbal: 5 to 7 minutes.",
            "score": 0.795_02,
        },
    ])
}

fn no_search() -> Value {
    json!({"items": [{"kind": "text", "text": "No Searches"}]})
}

#[test]
fn a_search_asks_tavily_on_the_persons_account_and_keeps_and_shows_what_came_up() {
    let mut files = installed();

    assert_eq!(look(&files), no_search());

    let (asked, came) = search(
        &mut files,
        &json!({"query": TEA}),
        &[Ok(found(TEA, &tea()))],
        NOON,
    );
    let [fetch] = asked.as_slice() else {
        panic!("it asked for {} requests", asked.len());
    };

    assert_eq!(fetch.url().as_str(), "https://api.tavily.com/search");
    assert_eq!(fetch.method(), Method::Post);
    assert_eq!(
        fetch.headers(),
        [("content-type", "application/json".to_owned())]
    );
    // A basic search, one credit of the person's plan, for five results.
    assert_eq!(
        serde_json::from_str::<Value>(fetch.body().unwrap()).unwrap(),
        json!({"query": TEA, "search_depth": "basic", "max_results": 5})
    );
    assert_eq!(fetch.account().map(Account::id), Some("tavily"));
    assert_eq!(
        came,
        Some(Ok(json!({"query": TEA, "results": [
            {"title": "Green tea brewing guide", "url": "https://www.teaguide.example/green-tea",
             "lines": "Steep green tea for two to three minutes in water at about 80°C. Longer \
                       makes it bitter."},
            {"title": "Why green tea turns bitter", "url": "https://kitchennotes.example/bitter",
             "lines": "Water that is too hot and a long steep draw out tannins."},
            {"title": "Steeping times by type", "url": "https://brewtimes.example/times?type=all",
             "lines": "Green: 2 to 3 minutes. Black: 3 to 5 minutes. Herbal: 5 to 7 minutes."},
        ]})))
    );
    // Each result under the site it is from, the first named without its
    // `www.`, on the page of this search.
    assert_eq!(
        look(&files),
        json!({
            "items": [
                {"kind": "field", "text": TEA, "icon": "magnifier"},
                {"kind": "list", "rows": [
                    {"caption": "teaguide.example", "title": "Green tea brewing guide",
                     "subtitle": "Steep green tea for two to three minutes in water at about \
                                  80°C. Longer makes it bitter.",
                     "url": "https://www.teaguide.example/green-tea"},
                    {"caption": "kitchennotes.example", "title": "Why green tea turns bitter",
                     "subtitle": "Water that is too hot and a long steep draw out tannins.",
                     "url": "https://kitchennotes.example/bitter"},
                    {"caption": "brewtimes.example", "title": "Steeping times by type",
                     "subtitle": "Green: 2 to 3 minutes. Black: 3 to 5 minutes. Herbal: 5 to 7 \
                                  minutes.",
                     "url": "https://brewtimes.example/times?type=all"},
                ]},
            ],
            "page": millis(NOON).to_string(),
        })
    );
    assert_eq!(
        files.documents["apps/search.json"],
        json!({"storage": {"search": {"query": TEA, "searched": millis(NOON), "results": [
            {"title": "Green tea brewing guide", "url": "https://www.teaguide.example/green-tea",
             "site": "teaguide.example",
             "lines": "Steep green tea for two to three minutes in water at about 80°C. Longer \
                       makes it bitter."},
            {"title": "Why green tea turns bitter", "url": "https://kitchennotes.example/bitter",
             "site": "kitchennotes.example",
             "lines": "Water that is too hot and a long steep draw out tannins."},
            {"title": "Steeping times by type", "url": "https://brewtimes.example/times?type=all",
             "site": "brewtimes.example",
             "lines": "Green: 2 to 3 minutes. Black: 3 to 5 minutes. Herbal: 5 to 7 minutes."},
        ]}}, "rings": []})
    );
}

#[test]
fn a_results_lines_are_cut_at_a_word_within_400_characters_and_one_no_row_takes_is_passed_over() {
    let sentence = "Steep green tea for two to three minutes.";
    // Seventeen characters with no space between them, the last an emoji.
    let japanese = "緑茶は八十度のお湯で二分から三分🍵";
    let mut files = installed();
    let (_, came) = search(
        &mut files,
        &json!({"query": TEA}),
        &[Ok(found(
            TEA,
            &json!([
                {
                    "title": "Green tea, at length",
                    "url": "https://teaguide.example/at-length",
                    "content": format!("{sentence}\n\n").repeat(10),
                    "score": 0.9,
                },
                {
                    "title": "緑茶の淹れ方",
                    "url": "https://ocha.example/green",
                    "content": japanese.repeat(25),
                    "score": 0.8,
                },
                {
                    "title": "Green tea, far away",
                    "url": format!("https://teaguide.example/{}", "far/".repeat(512)),
                    "content": sentence,
                    "score": 0.7,
                },
            ]),
        ))],
        NOON,
    );
    let told = came.unwrap().unwrap();
    let lines: Vec<&Value> = told["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|result| &result["lines"])
        .collect();

    // White space made single, then cut at the last word that leaves room
    // for the ellipsis, and inside a word when no space comes before it:
    // 398 characters, and 400. The page whose address no row takes is not
    // among them.
    assert_eq!(
        lines,
        [
            &json!(format!("{} Steep green tea for…", [sentence; 9].join(" "))),
            &json!(format!("{}緑茶は八十度のお…", japanese.repeat(23))),
        ]
    );
}

#[test]
fn a_search_that_finds_nothing_says_so_on_a_page_of_its_own_in_place_of_the_one_before() {
    let mut files = installed();
    let nonsense = "xyzzy plugh";

    search(
        &mut files,
        &json!({"query": TEA}),
        &[Ok(found(TEA, &tea()))],
        NOON,
    );

    let (_, came) = search(
        &mut files,
        &json!({"query": nonsense}),
        &[Ok(found(nonsense, &json!([])))],
        LATER,
    );

    assert_eq!(came, Some(Ok(json!({"query": nonsense, "results": []}))));
    assert_eq!(
        look(&files),
        json!({
            "items": [
                {"kind": "field", "text": nonsense, "icon": "magnifier"},
                {"kind": "text", "text": "No Results"},
            ],
            "page": millis(LATER).to_string(),
        })
    );
    assert_eq!(
        files.documents["apps/search.json"]["storage"],
        json!({"search": {"query": nonsense, "searched": millis(LATER), "results": []}})
    );
}

#[test]
fn a_search_refused_by_its_input_by_tavily_or_by_her_phones_caller_says_why_and_keeps_nothing() {
    let mut files = installed();
    let written = files.writes;
    let query = |text: &str| json!({"query": text});
    let refused = |rule: &str| {
        format!(
            "Web Search cannot take that: search input field \"query\" is refused: its value {rule}"
        )
    };
    let not_one_line = refused(r#"does not match "^[^\n\r]*\S[^\n\r]*$""#);
    // Tavily's answer of `status`, with the error it says.
    let tavily = |status: u16, error: &str| {
        vec![Ok(answer(
            status,
            &json!({"detail": {"error": error}}).to_string(),
        ))]
    };
    let says = |sentence: &str| format!("Web Search: {sentence}");
    let used_up = says("The Tavily account in Settings has used up its searches.");
    let no_key = "This needs Sam's Tavily account, and its key is not in Settings yet.";

    for (given, answers, refusal) in [
        (query(" "), vec![], not_one_line.clone()),
        (query("green tea\nblack tea"), vec![], not_one_line),
        (
            query(&"a".repeat(401)),
            vec![],
            refused("is longer than 400 characters"),
        ),
        (
            query(TEA),
            tavily(401, "Unauthorized: missing or invalid API key."),
            says("Tavily did not take the key in Settings."),
        ),
        (
            query(TEA),
            tavily(
                429,
                "Your request has been blocked due to excessive requests.",
            ),
            says("Tavily says there were too many searches at once. Try again in a moment."),
        ),
        (
            query(TEA),
            tavily(432, "This request exceeds your plan's set usage limit."),
            used_up.clone(),
        ),
        (
            query(TEA),
            tavily(433, "This request exceeds the pay-as-you-go limit."),
            used_up,
        ),
        (
            query(TEA),
            tavily(500, "Internal Server Error"),
            says("The search did not work: Tavily answered with status 500."),
        ),
        (
            query(TEA),
            vec![Ok(answer(
                200,
                "<!doctype html><title>Sign in to the Wi-Fi</title>",
            ))],
            says("The search did not work: Tavily did not answer as it should."),
        ),
        (query(TEA), vec![Err(no_key.to_owned())], says(no_key)),
    ] {
        assert_eq!(
            search(&mut files, &given, &answers, NOON).1,
            Some(Err(refusal)),
            "{given}"
        );
    }

    assert_eq!(files.writes, written);
    assert_eq!(look(&files), no_search());
}
