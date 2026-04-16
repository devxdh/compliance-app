import { app } from "./app";
import { ENV } from "./config/env.config";

app.listen(ENV.PORT, () => {
    console.log(`[SERVER] is listening at ${ENV.PORT}`);
})