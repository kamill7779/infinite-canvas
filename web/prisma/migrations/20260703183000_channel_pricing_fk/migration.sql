-- CreateIndex
CREATE UNIQUE INDEX "AiChannel_name_key" ON "AiChannel"("name");

-- AddForeignKey
ALTER TABLE "ModelPricing" ADD CONSTRAINT "ModelPricing_channel_fkey" FOREIGN KEY ("channel") REFERENCES "AiChannel"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

