export const games = [
    {
        id: "gi",
        name: "Genshin Impact",
        badge: "GI", icon: "gi-icon.png",
        style: "gi-theme",
        daily: [
            "Login",
            "Commissions",
            "Expedition",
            "Resin",
            { label: "Traveler's Tales", optional: true },
            { label: "Blessing of the Welkin Moon", optional: true }
        ],
        weekly: [
            "Trounce Domain", "Cook", "Forge",
            { label: "Special Recruitment Project", optional: true },
            "Furnishings", "Realm Depot", "Traveling Salesman",
        ],
        monthly: ["Stardust Exchange"],
        // Spiral Abyss and Imaginarium Theater alternate month to month (only
        // one is actually playable in a given patch), each on its own reset
        // cadence - see the dedicated reset checks in script.js. Both show
        // here regardless of which is currently live; use whichever applies.
        abyss: [
            { label: "Spiral Abyss", optional: true },
            { label: "Imaginarium Theater", optional: true },
        ],
    },
    {
        id: "hi3",
        name: "Honkai Impact 3rd",
        badge: "HI3", icon: "hi3-icon.png",
        style: "hi3-theme",
        daily: [
            "Daily Login", "Mei's Snacks", "Material Events", "Coin Collection",
            "Expeditions", "Errands", "Commissions", "Logistics Terminal",
        ],
        weekly: [
            "BP Chest", "Weekly Share", "Weekly Quiz", "Homu Hoard", "Contributions",
            "Realms of Battle", "Universal Mirage", "Mirage Store", "Elysian Realm", "Elysian Shop",
        ],
        monthly: ["Armada Terminal", "War Treasury"],
    },
    {
        id: "hsr",
        name: "Honkai: Star Rail",
        badge: "HSR", icon: "hsr-icon.png",
        style: "hsr-theme",
        daily: ["Daily Training", "Assignments"],
        weekly: ["Echo of War", "Simulated Universe/Currency Wars"],
        monthly: ["Embers Exchange", "Self-Modeling Resin"],
    },
    {
        id: "zzz",
        name: "Zenless Zone Zero",
        badge: "ZZZ", icon: "zzz-icon.png",
        style: "zzz-theme",
        daily: [
            "Login",
            "Dennies",
            "Battery Charge",
            { label: "Agent Trust", optional: true },
            {
                label: "Errands",
                min: 4,
                // "Login" here is the same task as the standalone Login item
                // above, not a separate errand - script.js keeps the two
                // checkboxes mirrored so checking either one checks both.
                sub: ["Login", "Coffee", "Divination/Scratch Card", "Video Store", "Suibian Temple", "Agent Invite"],
            },
        ],
        weekly: ["Ridu Weekly", "Notorious Hunt", "Hollow Zero"],
        monthly: ["Fading Signal", "Bangbuck", "Scott Outpost | Logistic Shop"],
    },
];
