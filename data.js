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
            "Trounce Domain", "Cook", "Forge", "Furnishings", "Realm Depot", "Traveling Salesman",
            { label: "Special Recruitment Project", optional: true },
        ],
        monthly: ["Stardust Exchange"],
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
                sub: ["Coffee", "Divination/Scratch Card", "Video Store", "Suibian Temple", "Agent Invite"],
            },
        ],
        weekly: ["Ridu Weekly", "Notorious Hunt", "Hollow Zero"],
        monthly: ["Fading Signal", "Bangbuck", "Scott Outpost | Logistic Shop"],
    },
];
