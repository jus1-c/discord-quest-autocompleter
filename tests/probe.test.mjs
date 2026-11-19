import assert from "node:assert/strict";
import test from "node:test";

async function loadProbe() {
    try {
        return await import("../plugins/quest-autocompleter/probe.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Activity probe is not implemented");
        throw error;
    }
}

// Copied from the public bundle of application 1557307363499712582 ("Wild Horse Nine").
const WILD_HORSE_HTML = `<!DOCTYPE html><html lang=en><script type=module src=/arise-frontend.ce53621c.js></script></html>`;

const WILD_HORSE_BUNDLE = `
async function d(e,t){let n=Date.now();if(n-c<5e3)return console.log("[Arise] Skipping quest progress"),{wasSuccessful:!1,throttled:!0};c=n;
try{let n=await h("POST","/quest/progress",{progress:e,quest_id:t}),r=n?.status==="ok";return{wasSuccessful:r}}catch(t){return{wasSuccessful:!1}}}
async function o(e){return await h("POST","/authorize",{code:e,activityId:m()})}
async function s(){return await h("POST","/arise/register")}
async function l(){if(!a)throw Error("No auth token set");return await h("GET","/quest/status")}
async function h(e,t,o,i=1e4){let u=await fetch("/.proxy/acf"+t,{method:e,headers:{
"Content-Type":"application/json","X-Auth-Token":a||"",
"X-Universe-ID":"ecd7bb92-1e08-4ad1-b76f-0d33c5013295",
"X-Discord-Activity-Id":l,"X-Discord-Hostname":window.location.hostname,"X-Arise-Client":r.appVersion
},body:o?JSON.stringify(o):void 0})}
initialState:{universeId:window.localStorage.getItem("ARISE_UNIVERSEID")||"ecd7bb92-1e08-4ad1-b76f-0d33c5013295"}
`;

// Copied from application 1557799582732124221 ("Exoplanet"), the one the shipped recipe targets.
const ARISE_BUNDLE = WILD_HORSE_BUNDLE.replace("ecd7bb92-1e08-4ad1-b76f-0d33c5013295", "d5f3e8ae-12a3-4aa9-a0f0-25e1aa92416b");

test("the probe finds the bundle a page loads", async () => {
    const { findBundleUrl } = await loadProbe();
    assert.equal(
        findBundleUrl(WILD_HORSE_HTML, "1557307363499712582"),
        "https://1557307363499712582.discordsays.com/arise-frontend.ce53621c.js"
    );
    assert.equal(findBundleUrl("<html></html>", "1"), null);
    assert.equal(findBundleUrl(undefined, "1"), null);
});

test("the universe id is read, and it differs per application", async () => {
    const { findUniverseId } = await loadProbe();
    assert.equal(findUniverseId(WILD_HORSE_BUNDLE), "ecd7bb92-1e08-4ad1-b76f-0d33c5013295");
    assert.equal(findUniverseId(ARISE_BUNDLE), "d5f3e8ae-12a3-4aa9-a0f0-25e1aa92416b");
    assert.equal(findUniverseId("no id here"), null);
});

test("the probe reports the client header and the acf paths", async () => {
    const { findClientHeader, findAcfPaths } = await loadProbe();
    // The bundle passes an expression, so no literal is available; that is reported as null.
    assert.equal(findClientHeader(WILD_HORSE_BUNDLE), null);
    assert.equal(findClientHeader(`"X-Arise-Client":"astronaut-prod-main-46567f6"`), "astronaut-prod-main-46567f6");

    const paths = findAcfPaths(WILD_HORSE_BUNDLE);
    for (const expected of ["/quest/progress", "/authorize", "/arise/register", "/quest/status"]) {
        assert.ok(paths.includes(expected), `expected ${expected} in ${paths.join(", ")}`);
    }
});

test("the progress body and its success condition are read from the bundle", async () => {
    const { findProgressShape } = await loadProbe();
    const shape = findProgressShape(WILD_HORSE_BUNDLE);
    assert.deepEqual(shape.keys, ["progress", "quest_id"]);
    assert.equal(shape.successField, "status");
    assert.equal(shape.successValue, "ok");
});

test("parsing one activity yields everything the handshake needs", async () => {
    const { parseActivity } = await loadProbe();
    const probe = parseActivity("1557307363499712582", WILD_HORSE_HTML, WILD_HORSE_BUNDLE);

    assert.equal(probe.appId, "1557307363499712582");
    assert.equal(probe.universeId, "ecd7bb92-1e08-4ad1-b76f-0d33c5013295");
    assert.equal(probe.progress.successValue, "ok");
    assert.ok(probe.acfPaths.includes("/quest/progress"));
});

test("probe headers are the ones the activity's own client sends", async () => {
    const { headersFromProbe, parseActivity } = await loadProbe();
    const probe = parseActivity("1557307363499712582", WILD_HORSE_HTML, WILD_HORSE_BUNDLE);
    const headers = headersFromProbe(probe, { appId: "1557307363499712582", hostname: "1557307363499712582.discordsays.com" });

    assert.equal(headers["X-Universe-ID"], "ecd7bb92-1e08-4ad1-b76f-0d33c5013295");
    assert.equal(headers["X-Discord-Activity-Id"], "1557307363499712582");
    assert.equal(headers["X-Discord-Hostname"], "1557307363499712582.discordsays.com");
    // An expression cannot be evaluated, so the header is simply left out.
    assert.equal(headers["X-Arise-Client"], undefined);
});

test("a probe that cannot read the application returns nothing instead of throwing", async () => {
    const { probeActivity } = await loadProbe();

    assert.equal(await probeActivity({ appId: "not-numeric", request: async () => ({}) }), null);
    assert.equal(await probeActivity({ appId: "123", request: undefined }), null);
    assert.equal(await probeActivity({ appId: "123", request: async () => { throw new Error("offline"); } }), null);
    // A page with no module script.
    assert.equal(await probeActivity({ appId: "123", request: async () => ({ body: "<html></html>" }) }), null);
});

test("probing reads the page and then its bundle over the native transport", async () => {
    const { probeActivity } = await loadProbe();
    const asked = [];
    const probe = await probeActivity({
        appId: "1557307363499712582",
        request: async url => {
            asked.push(url);
            return url.endsWith(".js") ? { body: WILD_HORSE_BUNDLE } : { body: WILD_HORSE_HTML };
        }
    });

    assert.deepEqual(asked, [
        "https://1557307363499712582.discordsays.com/",
        "https://1557307363499712582.discordsays.com/arise-frontend.ce53621c.js"
    ]);
    assert.equal(probe.universeId, "ecd7bb92-1e08-4ad1-b76f-0d33c5013295");
});

test("a bundle built by another framework yields nulls, not a wrong id", async () => {
    const { probeActivity } = await loadProbe();
    const probe = await probeActivity({
        appId: "999",
        request: async url => ({
            body: url.endsWith(".js") ? "console.log('hello')" : `<script src=/app.js></script>`
        })
    });

    assert.equal(probe.universeId, null);
    assert.equal(probe.client, null);
    assert.deepEqual(probe.acfPaths, []);
    assert.equal(probe.progress, null);
});
